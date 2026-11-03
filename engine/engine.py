"""The core loop: isolate -> agent works -> engine verifies -> merge or retry -> escalate."""
from __future__ import annotations

import json
import subprocess
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from threading import Lock
from typing import Callable

from engine.interfaces import Agent, Sandbox, Task

MAX_ATTEMPTS = 3


class SetupError(RuntimeError):
    """The environment is broken (missing tool, unreachable service), not the agent's work."""


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
    status: str = "queued"      # merged | failed | merge_conflict | error | blocked
    attempts: list[Attempt] = field(default_factory=list)
    error: str = ""

    @property
    def first_pass(self) -> bool:
        return self.status == "merged" and len(self.attempts) == 1

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
                 max_attempts: int = MAX_ATTEMPTS):
        self.repo = Path(repo)
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
        for path, body in task.hidden_tests.items():     # added only now, so they can't be gamed
            box.write_file(path, body)
        r = box.exec(task.test_cmd)
        tail = "\n".join(r.output.strip().splitlines()[-15:])
        if r.code in (126, 127) or "No module named pytest" in r.output:
            # The checks themselves couldn't run. That's a setup problem, not the agent's fault:
            # stop instead of burning retries and recording false "silent failures".
            raise SetupError(f"test command could not run (exit {r.code}): {tail[-300:]}")
        if r.code != 0:
            return False, "acceptance tests failed", changed, tail
        return True, "", changed, tail

    # ------------------------------------------------------------------ task
    def run_task(self, task: Task) -> Result:
        res = Result(task.id, task.title)
        feedback = None
        try:
            for n in range(1, self.max_attempts + 1):
                t0 = time.time()
                with self.make_sandbox(task, n) as box:
                    rep = self.agent.run(task, box, attempt=n, feedback=feedback)
                    ok, reason, changed, out = self.verify(task, box)
                    res.attempts.append(Attempt(n, rep.claim, ok, reason, changed, out,
                                                round(time.time() - t0, 1), rep.cost_usd, rep.turns))
                    if ok:
                        box.publish(f"{task.id}: {task.title}")
                        res.status = self.merge(box.branch, task.id)
                        return res
                    feedback = f"Your previous attempt was rejected: {reason}." + (f"\nTest output:\n{out}" if out else "")
            res.status = "failed"
        except Exception as e:                                  # infra problems are reported, not hidden
            res.status, res.error = "error", f"{type(e).__name__}: {e}"
        return res

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
        pending = {t.id: t for t in tasks}
        results: dict[str, Result] = {}
        with ThreadPoolExecutor(parallel) as pool:
            running = {}
            while pending or running:
                blocked_any = True
                while blocked_any:                          # propagate failures down the graph
                    blocked_any = False
                    for tid, t in list(pending.items()):
                        bad = [d for d in t.depends_on if d in results and results[d].status != "merged"]
                        if bad:
                            results[tid] = Result(tid, t.title, status="blocked",
                                                  error=f"waiting on {', '.join(bad)}, which did not merge")
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


def results_to_json(results: list[Result]) -> str:
    rows = []
    for r in results:
        d = asdict(r)
        d.update(first_pass=r.first_pass, silent_failures=r.silent_failures, cost_usd=r.cost_usd, seconds=r.seconds)
        rows.append(d)
    return json.dumps(rows, indent=2)
