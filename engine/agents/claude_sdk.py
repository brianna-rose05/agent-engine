"""Claude agent run in-process with the Claude Agent SDK, working in a local sandbox directory.
Needs ANTHROPIC_API_KEY. Use with LocalWorktreeSandbox."""
from __future__ import annotations

import asyncio

from engine.agents.prompt import build_prompt, parse_claim, system_rules
from engine.interfaces import AgentReport, Sandbox, Task

TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]


class ClaudeSDKAgent:
    def __init__(self, model: str = "sonnet", max_turns: int = 40, budget_usd: float = 1.00):
        self.model, self.max_turns, self.budget_usd = model, max_turns, budget_usd

    def options(self, task: Task, box: Sandbox):
        from claude_agent_sdk import ClaudeAgentOptions
        return ClaudeAgentOptions(
            cwd=box.workdir,
            tools=TOOLS,                      # the only tools that exist for this agent
            allowed_tools=TOOLS,              # pre-approved, so it never stops to ask
            permission_mode="dontAsk",        # anything else is denied, not prompted
            system_prompt={"type": "preset", "preset": "claude_code", "append": system_rules(task)},
            max_turns=self.max_turns,
            max_budget_usd=self.budget_usd,   # hard spend cap per attempt
            model=self.model,
            setting_sources=["project"],      # load the repo's own settings/CLAUDE.md, nothing from the host
        )

    async def _run(self, task: Task, box: Sandbox, feedback: str | None) -> AgentReport:
        from claude_agent_sdk import ResultMessage, query
        result = None
        async for msg in query(prompt=build_prompt(task, feedback), options=self.options(task, box)):
            if isinstance(msg, ResultMessage):
                result = msg
        if result is None:
            return AgentReport("error: no result from agent")
        failed = result.is_error or result.subtype != "success"
        claim = parse_claim(result.result, failed)
        if result.subtype == "error_max_budget_usd":
            claim = "error: hit the per-task budget cap"
        return AgentReport(claim, cost_usd=result.total_cost_usd or 0.0, turns=result.num_turns or 0,
                           summary=(result.result or "")[-500:])

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None) -> AgentReport:
        return asyncio.run(self._run(task, box, feedback))
