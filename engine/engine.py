"""The core loop: isolate -> agent works -> engine verifies -> merge or retry -> escalate."""
from __future__ import annotations

import inspect
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

from engine.budget import STOPPED, Budget
from engine.events import Emitter
from engine.gitlock import repo_lock
from engine.interfaces import Agent, Sandbox, SandboxLost, SandboxUnavailable, Task

MAX_ATTEMPTS = 3
EXTRA_ATTEMPTS = 2             # tries the tech lead can add after reviewing a failed task (docs/tech-lead.md)
MAX_DIFF_CHARS = 8000          # of the last failed attempt's diff, for the tech lead
STRONGEST_MODELS = ("sonnet",)  # the strongest dev model the tech lead may switch to (never opus)
TECH_LEAD_FAILED_QUESTION = ("The tech lead couldn't review this feature after the dev's tries failed. Should the team "
                             "try again as it is, or should the feature be described differently or dropped?")
RETRY_FAILED_QUESTION = ("The dev still couldn't finish this feature after the tech lead's guidance. How exactly "
                         "should it work, or should it be simplified or dropped?")
# The code reviewer (docs/reviewer.md): reviews a feature's passing attempt before it merges.
REVIEW_CHANGES = "the reviewer requested changes"   # the reason on an attempt the reviewer sent back
MAX_REVIEW_COMMENTS = 8
SECOND_REVIEW_NOTE = "Only a security problem can hold a feature back a second time, so these comments don't block it."
REVIEW_ERROR_NOTE = "The reviewer couldn't review this attempt, so it merges on its passing tests."
SCRUBBED_NOTE = "Its comments pointed at the hidden tests, which the dev never sees, so they were dropped."
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

# Seconds to wait before redoing an attempt whose sandbox dropped mid-way (SandboxLost); one entry per
# retry, so at most two per task. These are not the agent's tries. Regression: a Daytona "Remote end
# closed connection" in the middle of an attempt ended the task as "error" and blocked all its dependents.
INFRA_RETRIES = (10, 30)


class GraphError(ValueError):
    """The task plan itself is broken (unknown dependency, cycle). Caught before any money is spent."""


def check_graph(tasks: list[Task]) -> None:
    ids = [t.id for t in tasks]
    if len(set(ids)) != len(ids):
        raise GraphError("duplicate task ids")
    known = set(ids)
    for t in tasks:
        if missing := [d for d in [*t.depends_on, *t.waits_for] if d not in known]:
            raise GraphError(f"{t.id} depends on {', '.join(missing)}, which is not in this run")
    deps = {t.id: [*t.depends_on, *t.waits_for] for t in tasks}
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
                                # | stopped (the project's spending limit was reached before it could start or retry)
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
                 max_attempts: int = MAX_ATTEMPTS, events: Emitter | None = None, budget: Budget | None = None):
        self.repo = Path(repo)
        self.events = events or Emitter()
        self.budget = budget                    # the project's spending limit (engine/budget.py); None: no limit
        self.sandbox_retries = SANDBOX_RETRIES
        self.infra_retries = INFRA_RETRIES
        self.sleep = time.sleep
        self.clock = time.monotonic             # paces agent_activity events
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
        feedback = task.first_feedback               # e.g. the owner's answer to the tech lead's question
        emit = self.events.emit
        agent = task.agent or self.agent
        disputes, last_fixed = 0, False
        review, last_diff = None, ""                 # the tech lead's verdict (once per task), the last failed diff
        code_changes = 0                             # the code reviewer's "changes" verdicts so far (docs/reviewer.md)
        try:
            verdict = task.already_done() if task.already_done is not None else None
            if verdict == "unconfirmed" and self._out_of_budget(res):
                return res                            # the reviewer was stopped by the budget, not unconvinced
            if verdict == "unconfirmed":
                res.status = "failed"
                res.error = ("QA's tests all pass on the current code, and the reviewer didn't confirm they test the "
                             "change; retry to have QA write tests that do")
                return res
            if verdict == "confirmed" and self._holds_on_main(task):
                emit("task_status", task.id, status="already_done")
                res.status = "merged"                 # nothing to merge: main already does it, and we checked
                return res
            attempts = _Attempts(task.max_attempts or self.max_attempts)
            for n in attempts:
                if self._out_of_budget(res):          # no new attempt once the project's limit is reached
                    return res
                t0 = time.time()
                to_review = None                      # a passing attempt, published, waiting for its code review
                with self._open_sandbox(task, n, attempts) as box:
                    for path, body in task.setup_files.items():
                        box.write_file(path, body)
                    emit("task_status", task.id, status="working", attempt=n)
                    rep = self._run_agent(agent, task, box, n, feedback)
                    if self.budget is not None:
                        self.budget.add(rep.cost_usd)
                    if task.stop_when is not None and (why := task.stop_when(rep.claim)):
                        # Stopping is safe to take on the agent's word: nothing is merged, and nothing is retried.
                        a = Attempt(n, rep.claim, False, why, [], "", round(time.time() - t0, 1), rep.cost_usd, rep.turns)
                        res.attempts.append(a)
                        emit("attempt_finished", task.id, n=n, passed=False, claim=rep.claim, reason=why,
                             cost_usd=a.cost_usd, seconds=a.seconds, turns=a.turns, files_changed=[], output="")
                        res.status, res.error = "blocked", why
                        return res
                    emit("task_status", task.id, status="checking", attempt=n)
                    ok, reason, changed, out = self.verify(task, box)
                    if not ok and reason == "made no changes" and rep.claim.startswith("error"):
                        reason = rep.claim.removeprefix("error: ")   # say why: the agent itself failed
                    if ok and task.merge and task.review_code is not None:
                        # A different model reviews it before it merges. The work is published now and this sandbox
                        # closes, so a task never holds two sandboxes while its review runs.
                        to_review = (self._attempt_diff(box), changed, out, round(time.time() - t0, 1))
                        box.publish(f"{task.id}: {task.title}")
                        branch = box.branch
                    else:
                        self._attempt(res, task, n, rep, ok, reason, changed, out, round(time.time() - t0, 1))
                        if ok:
                            if not task.merge:
                                res.status = "passed"
                                return res
                            emit("task_status", task.id, status="merging", attempt=n)
                            box.publish(f"{task.id}: {task.title}")
                            res.status = self.merge(box.branch, task.id)
                            return res
                        feedback = f"Your previous attempt was rejected: {reason}." + (f"\nTest output:\n{out}" if out else "")
                        if task.review_failure is not None:      # for the tech lead, before the sandbox is gone
                            last_diff = self._attempt_diff(box)
                if attempts.redo:                    # the sandbox dropped mid-attempt: run that attempt again
                    continue
                if to_review is not None:
                    # The code review (docs/reviewer.md). Its verdict decides the attempt: approve merges it; changes
                    # makes it a failed attempt whose feedback is the reviewer's comments.
                    diff, changed, out, seconds = to_review
                    v = self._code_review(task, n, diff, second=code_changes > 0)
                    if v["verdict"] == "approve":
                        self._attempt(res, task, n, rep, True, "", changed, out, seconds)
                        emit("task_status", task.id, status="merging", attempt=n)
                        res.status = self.merge(branch, task.id)
                        return res
                    code_changes += 1
                    ok, reason = False, REVIEW_CHANGES
                    listed = "\n".join(f"- {c}" for c in v["comments"])
                    self._attempt(res, task, n, rep, False, reason, changed, listed, seconds)
                    feedback = ("Your previous attempt passed the acceptance tests, but the code reviewer (a different "
                                "model) requested changes. Fix these, and keep everything that already works:\n" + listed)
                    if task.review_failure is not None:      # for the tech lead, if every try ends up failing
                        last_diff = diff
                # One review per task, plus a second when the first found and fixed bad tests (they often come in
                # batches). Regression: Pawfect build 6, the referee fixed one batch and the dev then lost the
                # feature to two more tests whose setup the schema refused.
                may_dispute = disputes == 0 or (disputes == 1 and last_fixed)
                if (not ok and reason == "acceptance tests failed" and task.dispute and may_dispute
                        and n < attempts.limit):
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
                if n == attempts.limit and task.review_failure is not None and review is None:
                    # Every try failed. Before giving up, the tech lead (a stronger model than a Haiku dev) reviews
                    # the attempts once: up to two more tries with its guidance, or one question for the owner.
                    # Regression: Pawfect build 7 ended 24/25 with a failed feature and no explanation.
                    review = self._review(task, res, last_diff, agent)
                    if review is None:                   # the budget kept the review from happening
                        return res
                    if review["decision"] != "retry":
                        return self._escalate(res, review["question"])
                    attempts.limit += EXTRA_ATTEMPTS     # attempt numbers go on: 4, 5
                    agent = review.get("agent") or agent
                    feedback = f"Your tech lead reviewed the failed attempts: {review['note']}\n{feedback}"
            if review is not None:                       # the tech lead's extra tries failed too: no second review
                return self._escalate(res, review.get("question") or RETRY_FAILED_QUESTION)
            res.status = "failed"
        except Exception as e:                                  # infra problems are reported, not hidden
            res.status, res.error = "error", f"{type(e).__name__}: {e}"
        return res

    def _attempt(self, res: Result, task: Task, n: int, rep, ok: bool, reason: str, changed: list[str], out: str,
                 seconds: float) -> Attempt:
        """Record a finished attempt and tell the app. The failure itself travels with the event, so the app (and a
        person deciding what to do with a failed task) can see why. Regression: the first live build lost this."""
        a = Attempt(n, rep.claim, ok, reason, changed, out, seconds, rep.cost_usd, rep.turns)
        res.attempts.append(a)
        self.events.emit("attempt_finished", task.id, n=n, passed=ok, claim=rep.claim, reason=reason,
                         cost_usd=a.cost_usd, seconds=a.seconds, turns=a.turns, files_changed=changed,
                         output="" if ok else out[-3000:])
        return a

    def _code_review(self, task: Task, n: int, diff: str, second: bool) -> dict:
        """The code reviewer's verdict on a passing attempt (docs/reviewer.md), normalized: {verdict, comments, note?,
        review_error?, skipped?}. A passing feature is never lost to the review itself: a crashed or unusable review
        approves (review_error), and so does a spending limit that doesn't allow one (skipped). After one "changes"
        verdict (`second`), only a security problem may block again."""
        emit = self.events.emit
        if self.budget is not None and not self.budget.allows_start():
            emit("code_review", task.id, verdict="approve", comments=[], attempt=n, skipped=True)
            return {"verdict": "approve", "comments": [], "skipped": True}
        emit("task_status", task.id, status="reviewing_code", attempt=n)
        try:
            v = task.review_code(diff, second)
        except Exception as e:
            v = {"review_error": True, "note": f"{type(e).__name__}: {e}"}
        v = normalize_code_review(v, task.hidden_tests)
        if second and v["verdict"] == "changes" and not any(_security(c) for c in v["comments"]):
            v = {**v, "verdict": "approve", "note": SECOND_REVIEW_NOTE}
        event = {"verdict": v["verdict"], "comments": v["comments"], "attempt": n}
        if v.get("note"):
            event["note"] = v["note"]
        if v.get("review_error"):
            event["review_error"] = True
        emit("code_review", task.id, **event)
        return v

    def _attempt_diff(self, box: Sandbox) -> str:
        """The failed attempt's changes against the commit it started from, new files included, for the tech
        lead. Never fails the attempt (the sandbox is about to close anyway)."""
        try:
            r = box.exec("git add -A -N . >/dev/null 2>&1; git diff $(git merge-base HEAD main)")
        except Exception:
            return ""
        diff = r.output
        return diff if len(diff) <= MAX_DIFF_CHARS else diff[:MAX_DIFF_CHARS - 20] + "\n... (diff cut)"

    def _review(self, task: Task, res: Result, diff: str, agent) -> dict | None:
        """Run the task's tech lead review and tell the app. Returns the verdict (normalize_review), with "agent"
        set when the extra tries should use the stronger dev agent; None when the budget stopped it (the result
        is then marked stopped, as for any attempt the budget keeps from starting)."""
        if self._out_of_budget(res):
            return None
        self.events.emit("task_status", task.id, status="reviewing", attempt=res.attempts[-1].n)
        try:
            v = task.review_failure(list(res.attempts), diff)
        except Exception as e:
            v = {"decision": "escalate", "note": f"{type(e).__name__}: {e}", "tech_lead_error": True}
        v = normalize_review(v)
        if v.get("tech_lead_error") and self._out_of_budget(res):
            return None                              # the reviewer was stopped by the budget, not broken
        event = {"decision": v["decision"], "note": v["note"], "stronger_model": v["stronger_model"]}
        if v["decision"] == "escalate":
            event["question"] = v["question"]
        if v.get("tech_lead_error"):
            event["tech_lead_error"] = True
        stronger = task.stronger_agent
        if v["stronger_model"] and stronger is not None and stronger is not agent and not _strongest(agent):
            v["agent"] = stronger
            event["model"] = getattr(stronger, "model", None) or "sonnet"
        self.events.emit("tech_lead_review", task.id, **event)
        return v

    def _escalate(self, res: Result, question: str) -> Result:
        """The task ends failed with one question for the owner (the app shows it with an answer box)."""
        self.events.emit("escalated", res.task, question=question)
        res.status, res.error = "failed", f"Needs you: {question}"[:300]
        return res

    def _out_of_budget(self, res: Result) -> bool:
        """True (and the result marked stopped) when the spending limit keeps this task from going on."""
        if self.budget is None or self.budget.allows_start():
            return False
        res.status, res.error = STOPPED, self.budget.reason()
        return True

    def _holds_on_main(self, task: Task) -> bool:
        """QA said a change already holds (its tests all pass on the current code). Don't take its word for it:
        run the task's own checks, hidden tests included, on a fresh sandbox of main."""
        with self._open_sandbox(task, 0) as box:
            for path, body in task.hidden_tests.items():
                box.write_file(path, body)
            r = box.exec(task.test_cmd)
            box.exec("rm -f " + " ".join(shlex.quote(p) for p in task.hidden_tests))
        return r.code == 0

    def _run_agent(self, agent: Agent, task: Task, box: Sandbox, n: int, feedback: str | None):
        """Run the agent, streaming what it is doing as throttled `agent_activity` events when it can report
        progress (the CLI agent can; scripted and test agents don't take the argument). Without this a
        20-minute planner run showed one static line and the user thought it was stuck."""
        extra = {}
        if self.budget is not None and _takes(agent.run, "budget_cap"):   # never more than the project has left
            extra["budget_cap"] = self.budget.remaining
        if not _takes(agent.run, "progress"):
            return agent.run(task, box, attempt=n, feedback=feedback, **extra)
        activity = _Activity(lambda notes: self.events.emit("agent_activity", task.id, attempt=n,
                                                             note=notes[-1], notes=notes), self.clock)
        try:
            return agent.run(task, box, attempt=n, feedback=feedback, progress=activity.add, **extra)
        finally:
            activity.flush()

    def _open_sandbox(self, task: Task, n: int, attempts: "_Attempts | None" = None):
        """Create and enter a sandbox, waiting and retrying while the provider is at capacity
        (spec: provider outages retry with backoff instead of failing the task). Once entered, a
        SandboxLost inside the attempt is handed to _sandbox_lost, which may redo the attempt."""
        on_lost = (lambda e: self._sandbox_lost(task, n, attempts, e)) if attempts is not None else None
        for wait_s in (*self.sandbox_retries, None):
            box = self.make_sandbox(task, n)
            try:
                box.__enter__()
                return _Entered(box, on_lost)
            except Exception as e:
                # Only the provider being unavailable (capacity, 502s, timeouts) is worth waiting for. Our own
                # setup failing, or a local git error, fails fast. Regression: retrying every error turned a
                # local git lock hiccup into a 27-minute wait.
                if wait_s is None or not isinstance(e, SandboxUnavailable):
                    raise
                self.events.emit("task_status", task.id, status="waiting_for_sandbox", attempt=n, error=str(e)[:200])
                self.sleep(wait_s)

    def _sandbox_lost(self, task: Task, n: int, attempts: "_Attempts", e: Exception) -> bool:
        """A sandbox stopped answering during an attempt. That's the provider, not the agent: open a fresh
        one and redo the attempt, a few times per task. True means the attempt will run again."""
        used = attempts.infra_used
        if used >= len(self.infra_retries):
            return False                                        # out of retries: the task errors as before
        attempts.infra_used, attempts.redo = used + 1, True
        self.events.emit("task_status", task.id, status="sandbox_lost", attempt=n, retry=used + 1,
                         error=str(e)[:200])
        self.sleep(self.infra_retries[used])
        return True

    def merge(self, branch: str, task_id: str) -> str:
        # merge_lock: one merge at a time, main never half-merged. repo_lock: no worktree is being added or
        # removed while main moves (git keeps no lock of its own around that bookkeeping).
        with self.merge_lock, repo_lock(self.repo):
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
                if pending and self.budget is not None and not self.budget.allows_start():
                    for tid, t in pending.items():          # over budget: nothing else starts (running ones finish)
                        results[tid] = Result(tid, t.title, status=STOPPED, error=self.budget.reason())
                        self.events.emit("task_status", tid, status=STOPPED, error=results[tid].error)
                    pending.clear()
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
                    if all(d in results for d in [*t.depends_on, *t.waits_for]):
                        missing = [d for d in t.waits_for if results[d].status not in OK]
                        if missing:                         # it goes ahead, but the app should say so
                            self.events.emit("task_status", tid, status="without", missing=missing)
                        running[pool.submit(self.run_task, t)] = tid
                        del pending[tid]
                if not running:
                    break
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for f in done:
                    results[running.pop(f)] = f.result()
        return [results[t.id] for t in tasks]


ACTIVITY_EVERY_S = 10          # at most one agent_activity event per task this often
ACTIVITY_KEEP = 3              # notes carried by one event (the latest; older ones are dropped)


class _Activity:
    """Collects an agent's activity notes and emits them at most once every ACTIVITY_EVERY_S, keeping only
    the latest few. A planner makes hundreds of tool calls; an event for each would flood the app."""

    def __init__(self, emit: Callable[[list[str]], None], clock: Callable[[], float],
                 every: float = ACTIVITY_EVERY_S, keep: int = ACTIVITY_KEEP):
        self.emit, self.clock, self.every, self.keep = emit, clock, every, keep
        self.pending: list[str] = []
        self.last: float | None = None

    def add(self, notes: list[str]) -> None:
        self.pending = (self.pending + list(notes))[-self.keep:]
        now = self.clock()
        if self.pending and (self.last is None or now - self.last >= self.every):
            self._send(now)

    def flush(self) -> None:
        """The last notes of a run, so the app doesn't keep showing an older step."""
        if self.pending:
            self._send(self.clock())

    def _send(self, now: float) -> None:
        notes, self.pending, self.last = self.pending, [], now
        self.emit(notes)


def normalize_review(v) -> dict:
    """A tech lead verdict the engine can act on, whatever came back: {decision, note, question, stronger_model,
    tech_lead_error?}. Anything unusable is an escalation with tech_lead_error, so a broken review never
    quietly retries or drops the task."""
    if not isinstance(v, dict) or v.get("decision") not in ("retry", "escalate"):
        v = {"decision": "escalate", "note": v.get("note", "") if isinstance(v, dict) else "", "tech_lead_error": True}
    out = {"decision": v["decision"], "note": " ".join(str(v.get("note") or "").split())[:1500],
           "stronger_model": v.get("stronger_model") is True and v["decision"] == "retry"}
    question = " ".join(str(v.get("question") or "").split())
    if v.get("tech_lead_error"):
        out["tech_lead_error"], question = True, TECH_LEAD_FAILED_QUESTION
    elif out["decision"] == "escalate" and not question:
        question = TECH_LEAD_FAILED_QUESTION
    out["question"] = question[:280]                  # "Needs you: " + question fits Result.error's 300
    return out


def normalize_code_review(v, hidden_tests=()) -> dict:
    """A code review the engine can act on, whatever came back: {verdict: approve | changes, comments, note?,
    review_error?}. Comments are one plain line each, at most MAX_REVIEW_COMMENTS, and any line naming a hidden test
    file (its path or its file name) is dropped: comments reach the dev as feedback, and the dev never sees the hidden
    tests. Anything unusable approves with review_error, so a broken review never loses a passing feature."""
    if not isinstance(v, dict) or v.get("verdict") not in ("approve", "changes") or v.get("review_error"):
        why = " ".join(str(v.get("note") or "").split())[:200] if isinstance(v, dict) else ""
        return {"verdict": "approve", "comments": [], "review_error": True,
                "note": REVIEW_ERROR_NOTE + (f" ({why})" if why else "")}
    raw = v.get("comments")
    raw = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
    hidden = [h for p in hidden_tests for h in {p, p.rsplit("/", 1)[-1]} if h]
    comments = []
    for c in raw:
        lines = [ln for ln in str(c).splitlines() if not any(h in ln for h in hidden)]
        text = " ".join(" ".join(lines).split())[:500]
        if text:
            comments.append(text)
    comments = comments[:MAX_REVIEW_COMMENTS]
    if v["verdict"] == "changes" and not comments:
        if not any(str(c).strip() for c in raw):        # "changes" with nothing to change: not a usable review
            return {"verdict": "approve", "comments": [], "review_error": True, "note": REVIEW_ERROR_NOTE}
        return {"verdict": "approve", "comments": [], "note": SCRUBBED_NOTE}
    return {"verdict": v["verdict"], "comments": comments}


def _security(comment: str) -> bool:
    return comment.strip().lower().startswith("security:")


def _strongest(agent) -> bool:
    """True when the agent already runs the strongest model the tech lead may pick (or a stronger one)."""
    model = str(getattr(agent, "model", "") or "").lower()
    return any(m in model for m in (*STRONGEST_MODELS, "opus"))


def _takes(fn, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


class _Attempts:
    """Attempt numbers 1..limit. An attempt whose sandbox was lost (`redo` set) runs again under the same
    number, so infrastructure failures never use up the agent's tries. `limit` may grow while iterating (the tech
    lead's extra tries): the numbers then go on from where they were."""

    def __init__(self, limit: int):
        self.limit, self.redo, self.infra_used = limit, False, 0

    def __iter__(self):
        n = 1
        while n <= self.limit:
            self.redo = False
            yield n
            if not self.redo:
                n += 1


class _Entered:
    """Context manager around a sandbox that is already entered; exiting cleans it up. A SandboxLost
    raised inside is offered to `on_lost`; if that returns True the attempt will be redone, so the
    error is swallowed (and so is a failing cleanup of the dead sandbox)."""

    def __init__(self, box, on_lost=None):
        self.box, self.on_lost = box, on_lost

    def __enter__(self):
        return self.box

    def __exit__(self, exc_type, exc, tb):
        if isinstance(exc, SandboxLost) and self.on_lost is not None:
            try:
                self.box.__exit__(exc_type, exc, tb)
            except Exception:
                pass                    # the sandbox is already unreachable; its own expiry cleans it up
            return self.on_lost(exc)
        return self.box.__exit__(exc_type, exc, tb)


def results_to_json(results: list[Result]) -> str:
    rows = []
    for r in results:
        d = asdict(r)
        d.update(first_pass=r.first_pass, silent_failures=r.silent_failures, cost_usd=r.cost_usd, seconds=r.seconds)
        rows.append(d)
    return json.dumps(rows, indent=2)
