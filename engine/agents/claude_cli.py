"""Claude agent run as the `claude` CLI inside any sandbox (local or cloud) in headless mode.
The API key is passed as an environment variable for that one command, never written to disk
or put in the command line."""
from __future__ import annotations

import json
import os
import shlex

from engine.agents.prompt import build_prompt, parse_claim, system_rules
from engine.interfaces import AgentReport, Sandbox, Task

TOOLS = "Read,Edit,Write,Bash,Glob,Grep"


class ClaudeCLIAgent:
    def __init__(self, model: str = "sonnet", max_turns: int = 40, budget_usd: float = 1.00,
                 timeout_s: int = 30 * 60, api_key: str | None = None):
        self.model, self.max_turns, self.budget_usd, self.timeout_s = model, max_turns, budget_usd, timeout_s
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    def command(self, task: Task, feedback: str | None) -> str:
        args = ["claude", "--bare", "-p", build_prompt(task, feedback),
                "--output-format", "json",
                "--tools", TOOLS, "--allowedTools", TOOLS,
                "--permission-mode", "dontAsk",
                "--append-system-prompt", system_rules(task),
                "--max-turns", str(self.max_turns),
                "--max-budget-usd", f"{self.budget_usd:.2f}",
                "--model", self.model]
        # Stop the agent inside the sandbox a minute before our exec timeout, so a hung run comes back as a
        # failed attempt (and gets retried) instead of the sandbox connection timing out and killing the task.
        limit = max(60, self.timeout_s - 60)
        return f"timeout -k 20 {limit} " + " ".join(shlex.quote(a) for a in args)

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport:
        if not self.api_key:
            return AgentReport("error: ANTHROPIC_API_KEY is not set")
        run = getattr(box, "exec_long", box.exec)       # cloud sandboxes poll instead of holding a connection
        r = run(self.command(task, feedback), timeout=self.timeout_s,
                     # CI=1: test runners like Vitest exit instead of waiting for file changes
                     env={"ANTHROPIC_API_KEY": self.api_key, "CI": "1"})
        data = parse_cli_json(r.output)
        if data is None and r.code in (124, 137):
            return AgentReport(f"error: agent ran out of time ({max(60, self.timeout_s - 60) // 60} min) and was stopped")
        if data is None:
            return AgentReport(f"error: could not read agent output (exit {r.code})", summary=r.output[-500:])
        failed = r.code != 0 or bool(data.get("is_error")) or data.get("subtype", "success") != "success"
        claim = parse_claim(data.get("result"), failed)
        if data.get("subtype") == "error_max_budget_usd":
            claim = "error: hit the per-task budget cap"
        elif failed:
            # keep the CLI's own reason (e.g. an API error) so a failure can be diagnosed from the board
            detail = " ".join(str(data.get("result") or data.get("subtype") or f"exit {r.code}").split())[:300]
            claim = f"{claim} ({detail})"
        return AgentReport(claim, cost_usd=float(data.get("total_cost_usd") or 0.0),
                           turns=int(data.get("num_turns") or 0), summary=str(data.get("result") or "")[-500:])


def parse_cli_json(output: str) -> dict | None:
    """The CLI prints one JSON object; tolerate stray log lines before it."""
    for line in reversed(output.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    try:
        return json.loads(output)
    except (json.JSONDecodeError, ValueError):
        return None
