"""Stand-in agents for testing the engine and benchmark without an API key."""
from __future__ import annotations

import re
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


class ScriptedTeam:
    """Plays every role from a project fixture folder (plan/, acceptance/, solutions/), so the
    whole plan -> QA -> build pipeline can be tested without an API key. Change requests come from
    changes/<n>/ in the same layout, picked by the task id (C1PLAN, C1T2, C1T2-qa...)."""

    def __init__(self, fixture: Path):
        self.fixture = Path(fixture)

    def root(self, task: Task) -> Path:
        m = re.match(r"C(\d+)(PLAN|T)", task.id)
        return self.fixture / "changes" / m.group(1) if m else self.fixture

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport:
        root = self.root(task)
        if task.role == "planner":
            plan_dir = root / "plan"
            for f in sorted(x for x in plan_dir.rglob("*") if x.is_file()):
                box.write_file(str(f.relative_to(plan_dir)), f.read_text())
        elif task.id == "INT":                     # the integrator: pages and server actions
            src = self.fixture / "integration"
            for f in sorted(x for x in src.rglob("*") if x.is_file()):
                box.write_file(str(f.relative_to(src)), f.read_text())
        elif task.role == "qa":
            path = task.can_edit[0]
            box.write_file(path, (root / path).read_text())
        else:
            module = task.can_edit[0]
            box.write_file(module, (root / "solutions" / module).read_text())
        return AgentReport("done")
