"""Claude agent run as the `claude` CLI inside any sandbox (local or cloud) in headless mode.
The API key is passed as an environment variable for that one command, never written to disk
or put in the command line.

Output is stream-json: one JSON object per line as the agent works (tool calls included), ending with the
same `{"type": "result", ...}` object `--output-format json` prints. The lines in between become short
activity notes for the app, so a 20-minute planner run doesn't look stuck."""
from __future__ import annotations

import json
import os
import shlex
from typing import Callable

from engine.agents.prompt import build_prompt, parse_claim, system_rules
from engine.interfaces import AgentReport, Sandbox, Task

TOOLS = "Read,Edit,Write,Bash,Glob,Grep"


class ClaudeCLIAgent:
    def __init__(self, model: str = "sonnet", max_turns: int = 40, budget_usd: float = 1.00,
                 timeout_s: int = 30 * 60, api_key: str | None = None):
        self.model, self.max_turns, self.budget_usd, self.timeout_s = model, max_turns, budget_usd, timeout_s
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    def command(self, task: Task, feedback: str | None, budget_cap: float | None = None) -> str:
        # budget_cap: what is left of the project's spending limit (engine/budget.py), when lower than our own cap
        budget = self.budget_usd if budget_cap is None else max(0.01, min(self.budget_usd, budget_cap))
        args = ["claude", "--bare", "-p", build_prompt(task, feedback),
                "--output-format", "stream-json", "--verbose",   # stream-json needs --verbose with -p
                "--tools", TOOLS, "--allowedTools", TOOLS,
                "--permission-mode", "dontAsk",
                "--append-system-prompt", system_rules(task),
                "--max-turns", str(self.max_turns),
                "--max-budget-usd", f"{budget:.2f}",
                "--model", self.model]
        # Stop the agent inside the sandbox a minute before our exec timeout, so a hung run comes back as a
        # failed attempt (and gets retried) instead of the sandbox connection timing out and killing the task.
        limit = max(60, self.timeout_s - 60)
        return f"timeout -k 20 {limit} " + " ".join(shlex.quote(a) for a in args)

    def run(self, task: Task, box: Sandbox, attempt: int, feedback: str | None,
            progress: Callable[[list[str]], None] | None = None, budget_cap: float | None = None) -> AgentReport:
        """`progress(notes)` gets short notes on what the agent is doing ("Wrote src/x.ts") while it runs.
        Only sandboxes that poll a background command (exec_long) can stream; elsewhere it is never called."""
        if not self.api_key:
            return AgentReport("error: ANTHROPIC_API_KEY is not set")
        run = getattr(box, "exec_long", box.exec)       # cloud sandboxes poll instead of holding a connection
        extra = {}
        if progress is not None and hasattr(box, "exec_long"):
            extra["on_output"] = stream_notes(progress, getattr(box, "workdir", ""), self.api_key)
        r = run(self.command(task, feedback, budget_cap), timeout=self.timeout_s,
                     # CI=1: test runners like Vitest exit instead of waiting for file changes
                     env={"ANTHROPIC_API_KEY": self.api_key, "CI": "1"}, **extra)
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
    """The CLI's final result object; tolerate stray log lines around it. With stream-json, the lines before
    it are the agent's messages: skip those, or a run stopped by `timeout` (no result line) would be read as
    its last message instead of "ran out of time"."""
    for line in reversed(output.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and data.get("type", "result") == "result":
                return data
    try:
        return json.loads(output)
    except (json.JSONDecodeError, ValueError):
        return None


def _short_path(path: str, root: str) -> str:
    """'/home/daytona/repo/src/x.ts' -> 'src/x.ts': the app shows paths inside the project."""
    root = root.rstrip("/")
    if root.startswith("/") and path.startswith(root + "/"):
        return path[len(root) + 1:]
    marker = f"/{root.rsplit('/', 1)[-1]}/" if root else ""
    if marker and marker in path:
        return path.split(marker, 1)[1]
    return path


def _clip(text: str, n: int = 90) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def activity_notes(line: str, root: str = "") -> list[str]:
    """One stream-json line -> short notes ("Wrote src/x.ts", "Ran npx vitest run"). Only tool calls: they
    say what the agent is doing without sending its reasoning or file contents to the app."""
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, dict) or data.get("type") != "assistant":
        return []
    content = (data.get("message") or {}).get("content") or []
    notes = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name, args = block.get("name", ""), block.get("input") or {}
        path = _short_path(str(args.get("file_path") or args.get("notebook_path") or args.get("path") or ""), root)
        if name == "Write":
            notes.append(f"Wrote {path}")
        elif name in ("Edit", "MultiEdit", "NotebookEdit"):
            notes.append(f"Edited {path}")
        elif name == "Read":
            notes.append(f"Reading {path}")
        elif name == "Bash":
            notes.append(_clip(f"Ran {(args.get('command') or '').strip()}"))
        elif name == "Glob":
            notes.append(_clip(f"Looking for {args.get('pattern', 'files')}"))
        elif name == "Grep":
            notes.append(_clip(f"Searching for {args.get('pattern', '')}" + (f" in {path}" if path else "")))
        elif name:
            notes.append(f"Using {name}")
    return notes


def stream_notes(progress: Callable[[list[str]], None], root: str, secret: str = "") -> Callable[[str], None]:
    """An `on_output` callback for exec_long: buffers partial lines, turns each chunk into notes and hands
    them to `progress` in one call. The key is masked in case a command ever echoes it."""
    pending = [""]

    def feed(text: str) -> None:
        *lines, pending[0] = (pending[0] + text).split("\n")
        notes = [n for line in lines for n in activity_notes(line.strip(), root)]
        if len(secret) >= 8:                # a real key; a toy one would mangle ordinary words
            notes = [n.replace(secret, "***") for n in notes]
        if notes:
            try:
                progress(notes)
            except Exception:              # progress reporting must never take down a run
                pass
    return feed
