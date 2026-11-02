"""Stand-in agents for testing the engine and benchmark without an API key."""
from __future__ import annotations

from pathlib import Path

from engine.interfaces import AgentReport, Sandbox, Task


class ReferenceAgent:
    """Writes the known-correct solution. Every task should merge on the first try."""

    def __init__(self, solutions: Path):
        self.solutions = Path(solutions)

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport:
        module = task.can_edit[0]
        box.write_file(module, (self.solutions / module).read_text())
        return AgentReport("done")


class SloppyAgent(ReferenceAgent):
    """Mimics common real failures: first try says 'done' but is broken; also cheats on one task."""

    def __init__(self, solutions: Path, never_fix: tuple[str, ...] = (), cheat_on: tuple[str, ...] = ()):
        super().__init__(solutions)
        self.never_fix, self.cheat_on = set(never_fix), set(cheat_on)

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport:
        module = task.can_edit[0]
        if task.id in self.cheat_on and attempt == 1:
            box.write_file("store.py", "# 'simplified' the locked data model\n")     # out of scope
            return super().run(task, box, attempt, feedback)
        if attempt == 1 or task.id in self.never_fix:
            box.write_file(module, "from store import *  # noqa\n\n# looks finished, isn't\n")
            return AgentReport("done")                                              # silent failure
        return super().run(task, box, attempt, feedback)
