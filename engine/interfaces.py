"""The two swappable pieces. Everything else in the engine depends only on these."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class Task:
    id: str
    title: str
    spec: str                         # plain-English acceptance criteria the agent sees
    can_edit: list[str]               # glob patterns the agent may change
    test_cmd: str                     # run by the ENGINE, never trusted from the agent
    hidden_tests: dict[str, str] = field(default_factory=dict)  # path -> contents, added only at verify time


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
