"""What every dev agent is told. Shared so the in-process and CLI agents behave identically."""
from __future__ import annotations

from engine.interfaces import Task

RULES = """You are a dev agent on a software team. Complete exactly one task in this repository.
- Only edit these files: {scope}. Any other edit gets your work rejected automatically.
- Read AGENTS.md first and follow it.
- Hidden acceptance tests will be run against your work after you finish. Test your own code;
  you may add tests in the allowed test file pattern.
- Do not commit, push, or create branches. The engine handles git.
- End your final message with exactly one line: DONE, or BLOCKED: <short reason> if you cannot finish."""


def build_prompt(task: Task, feedback: str | None) -> str:
    parts = [f"Task {task.id}: {task.title}\n\n{task.spec}"]
    if feedback:
        parts.append(f"A previous attempt at this task was rejected. Fix the cause.\n{feedback}")
    return "\n\n".join(parts)


def system_rules(task: Task) -> str:
    return RULES.format(scope=", ".join(task.can_edit))


def parse_claim(final_text: str | None, is_error: bool) -> str:
    if is_error or not final_text:
        return "error: agent run did not finish"
    last = final_text.strip().splitlines()[-1].strip()
    if last.upper().startswith("BLOCKED"):
        return "blocked:" + last.split(":", 1)[-1] if ":" in last else "blocked"
    return "done" if last.upper().startswith("DONE") else "done (unclear)"
