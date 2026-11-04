"""The core loop: isolate -> agent works -> engine verifies -> merge or retry -> escalate."""
from __future__ import annotations

import json
import shlex
import subprocess
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from threading import Lock
from typing import Callable

from engine.events import Emitter
from engine.interfaces import Agent, Sandbox, SandboxUnavailable, Task

MAX_ATTEMPTS = 3
OK = ("merged", "passed")      # statuses that let dependent tasks start


class SetupError(RuntimeError):
    """The environment is broken (missing tool, unreachable service), not the agent's work."""


FAILURE_MARKERS = ("AssertionError", "Expected", "Received", "FAIL ", "error TS", "Error:", "assert ")


def failure_excerpt(output: str, limit: int = 4000) -> str:
    """What a retrying agent needs to see: the failure itself (expected vs received, the type error),
    not just the summary lines at the end. Regression: the first web run cut Vitest output to its last
    15 lines, which held the code frame and summary but not the diff, so the agent retried blind."""
    import re
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", output).strip()
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if any(m in l for m in FAILURE_MARKERS)), max(0, len(lines) - 15))
    excerpt = "\n".join(lines[max(0, start - 2):])
    if len(excerpt) > limit:
        excerpt = excerpt[: limit - 400] + "\n...\n" + "\n".join(lines[-8:])
    return excerpt


# Seconds to wait while the sandbox provider is at capacity (~27 min in all): other tasks finish and
# free memory. Regression: the fifth web run gave up on a retry after ~12 minutes.
SANDBOX_RETRIES = (30, 60, 120, 240, 300, 300, 300, 300)


class GraphError(ValueError):
    """The task plan itself is broken (unknown dependency, cycle). Caught before any money is spent."""


def check_graph(tasks: list[Task]) -> None:
    ids = [t.id for t in tasks]
    if len(set(ids)) != len(ids):
        raise GraphError("duplicate task ids")
    known = set(ids)
    for t in tasks:
        if missing := [d for d in t.depends_on if d not in known]:
            raise GraphError(f"{t.id} depends on {', '.join(missing)}, which is not in this run")
    deps = {t.id: list(t.depends_on) for t in tasks}
    state: dict[str, int] = {}                     # 1 = visiting, 2 = done

    def visit(tid: str, path: list[str]) -> None:
        if state.get(tid) == 2:
            return
        if state.get(tid) == 1:
            loop = path[path.index(tid):] + [tid]
            raise GraphError("dependency cycle: " + " -> ".join(loop))
        state[tid] = 1
        for d in deps[tid]:
            visit(d, path + [tid])
        state[tid] = 2

    for tid in ids:
        visit(tid, [])


@dataclass
class Attempt:
    n: int
    claim: str
    passed: bool
    reason: str                 # why it was rejected, in plain words ("" if passed)
    files_changed: list[str]
    test_output: str
    seconds: float
    cost_usd: float
    turns: int


@dataclass
class Result:
    task: str
    title: str
    status: str = "queued"      # merged | passed (verified, not merged) | failed | merge_conflict | error | blocked
    attempts: list[Attempt] = field(default_factory=list)
    error: str = ""

    @property
    def first_pass(self) -> bool:
        return self.status in OK and len(self.attempts) == 1

    @property
    def silent_failures(self) -> int:
        """Times the agent claimed success but the engine's checks disagreed."""
        return sum(1 for a in self.attempts if a.claim.lower().startswith("done") and not a.passed)

    @property
    def cost_usd(self) -> float:
        return round(sum(a.cost_usd for a in self.attempts), 4)

    @property
    def seconds(self) -> float:
        return round(sum(a.seconds for a in self.attempts), 1)


def git(args: list[str], repo: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


class Engine:
    def __init__(self, repo: Path, agent: Agent, make_sandbox: Callable[[Task, int], Sandbox],
                 max_attempts: int = MAX_ATTEMPTS, events: Emitter | None = None):
        self.repo = Path(repo)
        self.events = events or Emitter()
        self.sandbox_retries = SANDBOX_RETRIES
        self.sleep = time.sleep
        self.agent = agent
        self.make_sandbox = make_sandbox
        self.max_attempts = max_attempts
        self.merge_lock = Lock()
        self.remote = bool(git(["remote"], self.repo).stdout.strip())

    # ---------------------------------------------------------------- verify
    def verify(self, task: Task, box: Sandbox) -> tuple[bool, str, list[str], str]:
        # Diff against the commit this task started from, not `main`: main moves as parallel
        # tasks merge, which would make other tasks' files look like this agent's edits.
        changed = box.exec("git diff --name-only $(git merge-base HEAD main); "
                           "git ls-files --others --exclude-standard").output.split()
        changed = sorted(set(changed))
        if not changed:
            return False, "made no changes", changed, ""
        out_of_scope = [f for f in changed if not any(fnmatch(f, p) for p in task.can_edit)]
        if out_of_scope:
            return False, f"edited files outside its scope: {', '.join(out_of_scope)}", changed, ""
        if task.check is not None:                       # planner / QA work has its own verifier
            ok, reason, out = task.check(box)
            return ok, reason, changed, out
        for path, body in task.hidden_tests.items():     # added only now, so they can't be gamed
            box.write_file(path, body)
        r = box.exec(task.test_cmd)
        # Remove them again before anything is committed, or they'd merge into main where later
        # agents could read them (regression: milestone 3 found this leak).
        box.exec("rm -f " + " ".join(shlex.quote(p) for p in task.hidden_tests))
        tail = failure_excerpt(r.output)
        if r.code in (126, 127) or "No module named pytest" in r.output:
            # The checks themselves couldn't run. That's a setup problem, not the agent's fault:
            # stop instead of burning retries and recording false "silent failures".
            raise SetupError(f"test command could not run (exit {r.code}): {tail[-300:]}")
        if r.code != 0:
            return False, "acceptance tests failed", changed, tail
        return True, "", changed, tail

    # ------------------------------------------------------------------ task
    def run_task(self, task: Task) -> Result:
        res = self._run_task(task)
        self.events.emit("task_status", task.id, status=res.status, error=res.error, cost_usd=res.cost_usd)
        return res

    def _run_task(self, task: Task) -> Result:
        res = Result(task.id, task.title)
        feedback = None
        emit = self.events.emit
        agent = task.agent or self.agent
        disputes, last_fixed = 0, False
        try:
            for n in range(1, (task.max_attempts or self.max_attempts) + 1):
                t0 = time.time()
                with self._open_sandbox(task, n) as box:
                    for path, body in task.setup_files.items():
                        box.write_file(path, body)
                    emit("task_status", task.id, status="working", attempt=n)
                    rep = agent.run(task, box, attempt=n, feedback=feedback)
                    emit("task_status", task.id, status="checking", attempt=n)
                    ok, reason, changed, out = self.verify(task, box)
                    if not ok and reason == "made no changes" and rep.claim.startswith("error"):
                        reason = rep.claim.removeprefix("error: ")   # say why: the agent itself failed
                    a = Attempt(n, rep.claim, ok, reason, changed, out,
                                round(time.time() - t0, 1), rep.cost_usd, rep.turns)
                    res.attempts.append(a)
                    # The failure itself travels with the event, so the app (and a person deciding what to
                    # do with a failed task) can see why. Regression: the first live build lost this.
                    emit("attempt_finished", task.id, n=n, passed=ok, claim=rep.claim, reason=reason,
                         cost_usd=a.cost_usd, seconds=a.seconds, turns=a.turns, files_changed=changed,
                         output="" if ok else out[-3000:])
                    if ok:
                        if not task.merge:
                            res.status = "passed"
                            return res
                        emit("task_status", task.id, status="merging", attempt=n)
                        box.publish(f"{task.id}: {task.title}")
                        res.status = self.merge(box.branch, task.id)
                        return res
                    feedback = f"Your previous attempt was rejected: {reason}." + (f"\nTest output:\n{out}" if out else "")
                # One review per task, plus a second when the first found and fixed bad tests (they often come in
                # batches). Regression: Pawfect build 6, the referee fixed one batch and the dev then lost the
                # feature to two more tests whose setup the schema refused.
                may_dispute = disputes == 0 or (disputes == 1 and last_fixed)
                if (not ok and reason == "acceptance tests failed" and task.dispute and may_dispute
                        and n < (task.max_attempts or self.max_attempts)):
                    # A referee (a different model from the one that wrote the tests) checks the failing tests
                    # against the spec before the next try. Regression: in both live builds, features were
                    # lost to QA tests that contradicted the spec while the dev's code was right.
                    disputes += 1
                    emit("task_status", task.id, status="disputing", attempt=n)
                    # The dev's own account is evidence too ("the test inserts a booking the schema refuses").
                    said = f"\n\nThe dev agent's final message: {rep.claim}" if rep.claim.startswith("blocked") else ""
                    verdict = task.dispute(out + said)   # True: tests fixed, False: confirmed, None: referee failed
                    fixed = last_fixed = bool(verdict)
                    emit("dispute_resolved", task.id, test_fixed=fixed,
                         **({"referee_error": True} if verdict is None else {}))
                    if verdict is None:
                        pass                         # say nothing about the tests: nobody checked them
                    elif fixed:
                        feedback = ("A reviewer found that some hidden acceptance tests contradicted the spec, and "
                                    "they have been corrected. Implement the task exactly as the doc comments say.")
                    else:
                        feedback += "\nA reviewer checked these tests against the spec and confirmed they are right."
            res.status = "failed"
        except Exception as e:                                  # infra problems are reported, not hidden
            res.status, res.error = "error", f"{type(e).__name__}: {e}"
        return res

    def _open_sandbox(self, task: Task, n: int):
        """Create and enter a sandbox, waiting and retrying while the provider is at capacity
        (spec: provider outages retry with backoff instead of failing the task)."""
        for wait_s in (*self.sandbox_retries, None):
            box = self.make_sandbox(task, n)
            try:
                box.__enter__()
                return _Entered(box)
            except Exception as e:
                # Only the provider being unavailable (capacity, 502s, timeouts) is worth waiting for. Our own
                # setup failing, or a local git error, fails fast. Regression: retrying every error turned a
                # local git lock hiccup into a 27-minute wait.
                if wait_s is None or not isinstance(e, SandboxUnavailable):
                    raise
                self.events.emit("task_status", task.id, status="waiting_for_sandbox", attempt=n, error=str(e)[:200])
                self.sleep(wait_s)

    def merge(self, branch: str, task_id: str) -> str:
        with self.merge_lock:                                   # one merge at a time, main never half-merged
            if self.remote:
                git(["fetch", "-q", "origin", f"{branch}:{branch}"], self.repo)
            m = git(["merge", "--no-ff", "-q", branch, "-m", f"merge {task_id}"], self.repo)
            if m.returncode:
                git(["merge", "--abort"], self.repo)
                return "merge_conflict"
            if self.remote:
                git(["push", "-q", "origin", "main"], self.repo)
            return "merged"

    def run_all(self, tasks: list[Task], parallel: int = 4) -> list[Result]:
        """Run tasks as a dependency graph. A task starts only after everything it depends on has
        merged into main, so its sandbox already contains that code. If a dependency doesn't merge,
        everything downstream is marked blocked (escalated) instead of being attempted."""
        check_graph(tasks)
        for t in tasks:
            self.events.emit("task_queued", t.id, title=t.title, role=t.role, depends_on=list(t.depends_on))
        pending = {t.id: t for t in tasks}
        results: dict[str, Result] = {}
        with ThreadPoolExecutor(parallel) as pool:
            running = {}
            while pending or running:
                blocked_any = True
                while blocked_any:                          # propagate failures down the graph
                    blocked_any = False
                    for tid, t in list(pending.items()):
                        bad = [d for d in t.depends_on if d in results and results[d].status not in OK]
                        if bad:
                            results[tid] = Result(tid, t.title, status="blocked",
                                                  error=f"waiting on {', '.join(bad)}, which did not finish")
                            self.events.emit("task_status", tid, status="blocked", error=results[tid].error)
                            del pending[tid]
                            blocked_any = True
                for tid, t in list(pending.items()):
                    if all(d in results for d in t.depends_on):
                        running[pool.submit(self.run_task, t)] = tid
                        del pending[tid]
                if not running:
                    break
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for f in done:
                    results[running.pop(f)] = f.result()
        return [results[t.id] for t in tasks]


class _Entered:
    """Context manager around a sandbox that is already entered; exiting cleans it up."""

    def __init__(self, box):
        self.box = box

    def __enter__(self):
        return self.box

    def __exit__(self, *exc):
        return self.box.__exit__(*exc)


def results_to_json(results: list[Result]) -> str:
    rows = []
    for r in results:
        d = asdict(r)
        d.update(first_pass=r.first_pass, silent_failures=r.silent_failures, cost_usd=r.cost_usd, seconds=r.seconds)
        rows.append(d)
    return json.dumps(rows, indent=2)
