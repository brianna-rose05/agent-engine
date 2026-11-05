"""The two swappable pieces. Everything else in the engine depends only on these."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol


@dataclass
class Task:
    id: str
    title: str
    spec: str                         # plain-English acceptance criteria the agent sees
    can_edit: list[str]               # glob patterns the agent may change
    test_cmd: str                     # run by the ENGINE, never trusted from the agent
    hidden_tests: dict[str, str] = field(default_factory=dict)  # path -> contents, added only at verify time
    depends_on: list[str] = field(default_factory=list)         # task ids that must finish before this starts
    # task ids to wait for, without being blocked if they fail (the integrator stands in for a failed screen)
    waits_for: list[str] = field(default_factory=list)
    # change tasks: "confirmed" when QA's tests all pass and a reviewer agrees the change already holds (the engine
    # then checks it on main, no agent); "unconfirmed" when they pass but the reviewer disagrees; None otherwise
    already_done: Callable[[], str | None] | None = None
    role: str = "dev"                                           # dev | planner | qa (picks the agent's rules)
    # Custom verification instead of hidden tests: check(box) -> (passed, reason, output). Run by the engine.
    check: Callable[..., tuple[bool, str, str]] | None = field(default=None, repr=False)
    merge: bool = True                                          # False: verified work is kept out of main
    # Written into the sandbox before the agent starts (e.g. the tests a referee reviews).
    setup_files: dict[str, str] = field(default_factory=dict, repr=False)
    agent: object | None = field(default=None, repr=False)      # overrides the engine's agent (e.g. a referee)
    max_attempts: int | None = None                             # overrides the engine's retry limit
    # dispute(failure_output) -> True if the hidden tests were wrong and have been corrected.
    dispute: Callable[[str], bool] | None = field(default=None, repr=False)
    # stop_when(claim) -> a reason when the agent's final claim means this task can't be done this way (a quick change
    # that needs a change request): the task ends "blocked" with that reason, without checks or more tries.
    stop_when: Callable[[str], str | None] | None = field(default=None, repr=False)
    # review_failure(attempts, diff) -> the tech lead's verdict, once the last attempt has failed (docs/tech-lead.md):
    # {"decision": "retry" | "escalate", "note", "question", "stronger_model", "tech_lead_error"?}. `attempts` are the
    # engine's Attempt records, `diff` the last failed attempt's changes. None: no review (the task fails as before).
    review_failure: Callable[[list, str], dict] | None = field(default=None, repr=False)
    # The dev agent for the tech lead's extra attempts when it asks for a stronger model (never used otherwise).
    stronger_agent: object | None = field(default=None, repr=False)
    first_feedback: str | None = None                           # feedback for this run's first attempt (owner's answer)
    # review_code(diff, second) -> the code reviewer's verdict on an attempt that passed every check, before it merges
    # (docs/reviewer.md): {"verdict": "approve" | "changes", "comments": [...]}. `second` is True once the reviewer has
    # asked for changes on this task in this run (then only a security problem may block). None: merge as before.
    review_code: Callable[[str, bool], dict] | None = field(default=None, repr=False)
    # review_plan(files, round) -> the architect's verdict on a plan (or change plan) that passed its checks, before it
    # merges and before the owner is asked to approve it (docs/architect.md): {"verdict": "approve" | "changes",
    # "comments": [...]}. `files` are the planner's files ({path: contents}); `round` is 1, then 2 for the plan the
    # planner wrote with the architect's comments. None: no architect review (merge as before).
    review_plan: Callable[[dict, int], dict] | None = field(default=None, repr=False)


class SandboxUnavailable(RuntimeError):
    """The sandbox provider couldn't give us a sandbox right now (capacity, 5xx, timeouts).
    The engine waits and retries these; every other sandbox error fails fast."""


class SandboxLost(SandboxUnavailable):
    """A sandbox we already had stopped answering (connection dropped, timed out, sandbox gone).
    Raised by a sandbox's exec/write_file/publish. During an attempt the engine opens a fresh sandbox
    and redoes the attempt (a couple of times per task) instead of failing the task."""


@dataclass
class ExecResult:
    code: int
    output: str


@dataclass
class AgentReport:
    claim: str                        # what the agent says ("done", "blocked: ...")
    cost_usd: float = 0.0
    turns: int = 0
    summary: str = ""


class Sandbox(Protocol):
    """An isolated workspace holding a checkout of the repo on a task branch."""
    branch: str
    workdir: str                      # path inside the sandbox where the repo lives

    def __enter__(self) -> "Sandbox": ...
    def __exit__(self, *exc) -> None: ...
    def exec(self, cmd: str, timeout: int = 600, env: dict[str, str] | None = None) -> ExecResult: ...
    def write_file(self, path: str, content: str) -> None: ...
    def publish(self, message: str) -> None:
        """Commit the work and make the branch visible to the engine (push, or local ref)."""


class Agent(Protocol):
    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport: ...
