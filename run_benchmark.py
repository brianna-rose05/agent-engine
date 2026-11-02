"""Run the benchmark: python3 run_benchmark.py --agent reference|sloppy|claude-sdk|claude-cli [--sandbox local|daytona]

Writes results/<timestamp>/report.md and results.json with first-pass rate, silent failures
caught, retries, time, and cost per task."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from benchmark.suite import HERE as BENCH, build_repo, load_tasks
from engine.engine import Engine, Result, results_to_json

ROOT = Path(__file__).parent


def make_agent(a):
    from engine.agents.scripted import ReferenceAgent, SloppyAgent
    if a.agent == "reference":
        return ReferenceAgent(BENCH / "solutions")
    if a.agent == "sloppy":
        return SloppyAgent(BENCH / "solutions", never_fix=("B6",), cheat_on=("B3",))
    if a.agent == "claude-sdk":
        from engine.agents.claude_sdk import ClaudeSDKAgent
        return ClaudeSDKAgent(model=a.model, budget_usd=a.budget)
    if a.agent == "claude-cli":
        from engine.agents.claude_cli import ClaudeCLIAgent
        return ClaudeCLIAgent(model=a.model, budget_usd=a.budget)
    raise SystemExit(f"unknown agent {a.agent}")


def preflight(a) -> list[str]:
    """Catch missing setup before spending any money."""
    problems = []
    if a.agent.startswith("claude") and not os.environ.get("ANTHROPIC_API_KEY"):
        problems.append("ANTHROPIC_API_KEY is not set")
    if a.sandbox == "daytona":
        if a.agent == "claude-sdk":
            problems.append("claude-sdk runs on this machine; use --agent claude-cli with --sandbox daytona")
        for var in ("DAYTONA_API_KEY", "GITHUB_TOKEN"):
            if not os.environ.get(var):
                problems.append(f"{var} is not set")
        if not a.repo_url:
            problems.append("--repo-url is required with --sandbox daytona (an empty private GitHub repo)")
    return problems


def money(c: float) -> str:
    return f"${c:.4f}" if 0 < c < 0.01 else f"${c:.2f}"


def report(results: list[Result], a, seconds: float) -> str:
    n = len(results)
    merged = [r for r in results if r.status == "merged"]
    first = sum(r.first_pass for r in results)
    silent = sum(r.silent_failures for r in results)
    retries = sum(max(0, len(r.attempts) - 1) for r in results)
    cost = sum(r.cost_usd for r in results)
    lines = [
        f"# Benchmark report: {a.agent} on {a.sandbox}" + (f" ({a.model})" if a.agent.startswith("claude") else ""),
        "", f"{datetime.now():%Y-%m-%d %H:%M}, {n} tasks, {a.parallel} in parallel, wall time {seconds:.0f}s", "",
        "| Metric | Value |", "| --- | --- |",
        f"| Merged | {len(merged)} of {n} |",
        f"| First-try pass rate | {first}/{n} ({100 * first / n:.0f}%) |",
        f"| Silent failures caught (agent said done, checks said no) | {silent} |",
        f"| Retries used | {retries} |",
        f"| Total agent cost | {money(cost)} |",
        f"| Avg cost per merged task | {money(cost / max(1, len(merged)))} |",
        "", "| Task | Status | Tries | Silent fails | Time (s) | Cost | Why tries were rejected |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        why = "; ".join(f"#{t.n}: {t.reason}" for t in r.attempts if not t.passed) or r.error or "-"
        lines.append(f"| {r.task} {r.title} | {r.status} | {len(r.attempts)} | {r.silent_failures} | "
                     f"{r.seconds} | {money(r.cost_usd)} | {why} |")
    return "\n".join(lines) + "\n"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agent", default="reference", choices=["reference", "sloppy", "claude-sdk", "claude-cli"])
    p.add_argument("--sandbox", default="local", choices=["local", "daytona"])
    p.add_argument("--model", default="sonnet")
    p.add_argument("--budget", type=float, default=1.00, help="max USD per attempt")
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--tasks", nargs="*", help="e.g. B1 B2 (default: all)")
    p.add_argument("--repo-url", help="GitHub repo URL for --sandbox daytona")
    a = p.parse_args()

    if problems := preflight(a):
        print("Not ready to run:\n- " + "\n- ".join(problems))
        sys.exit(2)

    out = ROOT / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{a.agent}-{a.sandbox}"
    repo = build_repo(out / "repo")
    tasks = load_tasks(a.tasks)

    if a.sandbox == "local":
        from engine.sandboxes.local_worktree import LocalWorktreeSandbox
        factory = lambda t, n: LocalWorktreeSandbox(repo, t.id, n)
    else:
        from engine.sandboxes.daytona_sandbox import DaytonaSandbox
        token = os.environ["GITHUB_TOKEN"]
        authed = a.repo_url.replace("https://", f"https://x-access-token:{token}@")
        subprocess.run(["git", "remote", "add", "origin", authed], cwd=repo, check=True)
        subprocess.run(["git", "push", "-q", "-f", "origin", "main"], cwd=repo, check=True)
        factory = lambda t, n: DaytonaSandbox(a.repo_url, t.id, n, github_token=token)

    t0 = time.time()
    results = Engine(repo, make_agent(a), factory).run_all(tasks, parallel=a.parallel)
    md = report(results, a, time.time() - t0)
    (out / "report.md").write_text(md)
    (out / "results.json").write_text(results_to_json(results))
    print(md)
    print(f"Saved to {out}")


if __name__ == "__main__":
    main()
