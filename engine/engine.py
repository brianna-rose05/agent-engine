"""The core loop: isolate -> agent works -> engine verifies -> merge or retry -> escalate."""
from __future__ import annotations

import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from threading import Lock
from typing import Callable

from engine.interfaces import Agent, Sandbox, Task

MAX_ATTEMPTS = 3


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
    status: str = "queued"      # merged | failed | merge_conflict | error
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
        with ThreadPoolExecutor(parallel) as pool:
            return list(pool.map(self.run_task, tasks))


def results_to_json(results: list[Result]) -> str:
    rows = []
    for r in results:
        d = asdict(r)
        d.update(first_pass=r.first_pass, silent_failures=r.silent_failures, cost_usd=r.cost_usd, seconds=r.seconds)
        rows.append(d)
    return json.dumps(rows, indent=2)
