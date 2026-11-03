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


def load_env(path: Path) -> None:
    """Read KEY=VALUE lines from a private .env file (git-ignored). Values already set in the
    shell win. Never prints or logs anything it reads."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip().strip('"').strip("'")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


def map_secret_names() -> None:
    """GitHub reserves secret names starting with GITHUB_, so in Actions the paws-bench token
    arrives as BENCH_GITHUB_TOKEN. Accept either name."""
    if not os.environ.get("GITHUB_TOKEN") and os.environ.get("BENCH_GITHUB_TOKEN"):
        os.environ["GITHUB_TOKEN"] = os.environ["BENCH_GITHUB_TOKEN"]


def missing_modules(a) -> list[str]:
    import importlib.util
    needed = ["pytest"]
    if a.agent == "claude-sdk":
        needed.append("claude_agent_sdk")
    if a.sandbox == "daytona":
        needed.append("daytona")
    return [m for m in needed if importlib.util.find_spec(m) is None]


def preflight(a) -> list[str]:
    """Catch missing setup before spending any money."""
    problems = []
    if missing := missing_modules(a):
        problems.append(f"missing Python packages: {', '.join(missing)}. Run: pip install {' '.join(m.replace('_', '-') for m in missing)}")
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


def report(results: list[Result], a, seconds: float, needs: dict[str, list[str]] | None = None,
           title: str = "Benchmark report") -> str:
    needs = needs or {}
    n = len(results)
    merged = [r for r in results if r.status in ("merged", "passed")]   # passed = verified QA tests
    first = sum(r.first_pass for r in results)
    silent = sum(r.silent_failures for r in results)
    retries = sum(max(0, len(r.attempts) - 1) for r in results)
    cost = sum(r.cost_usd for r in results)
    lines = [
        f"# {title}: {a.agent} on {a.sandbox}" + (f" ({a.model})" if a.agent.startswith("claude") else ""),
        "", f"{datetime.now():%Y-%m-%d %H:%M}, {n} tasks, {a.parallel} in parallel, wall time {seconds:.0f}s", "",
        "| Metric | Value |", "| --- | --- |",
        f"| Finished and verified | {len(merged)} of {n} |",
        f"| Blocked (a task it depends on didn't merge) | {sum(r.status == 'blocked' for r in results)} |",
        f"| First-try pass rate | {first}/{n} ({100 * first / n:.0f}%) |",
        f"| Silent failures caught (agent said done, checks said no) | {silent} |",
        f"| Retries used | {retries} |",
        f"| Total agent cost | {money(cost)} |",
        f"| Avg cost per finished task | {money(cost / max(1, len(merged)))} |",
        "", "| Task | Needs | Status | Tries | Silent fails | Time (s) | Cost | Why tries were rejected |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        why = "; ".join(f"#{t.n}: {t.reason}" for t in r.attempts if not t.passed) or r.error or "-"
        lines.append(f"| {r.task} {r.title} | {', '.join(needs.get(r.task, [])) or '-'} | {r.status} | "
                     f"{len(r.attempts)} | {r.silent_failures} | "
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

    load_env(ROOT / ".env")
    map_secret_names()
    if problems := preflight(a):
        print("Not ready to run:\n- " + "\n- ".join(problems))
        sys.exit(2)

    run_id = f"{datetime.now():%Y%m%d-%H%M%S}"
    out = ROOT / "results" / f"{run_id}-{a.agent}-{a.sandbox}"
    repo = build_repo(out / "repo")
    if a.sandbox == "local":
        from engine.sandboxes.local_worktree import LocalWorktreeSandbox
        tasks = load_tasks(a.tasks, python=sys.executable)      # same machine, same Python
        factory = lambda t, n: LocalWorktreeSandbox(repo, t.id, n)
    else:
        from engine.sandboxes.daytona_sandbox import DaytonaSandbox
        tasks = load_tasks(a.tasks, python="python3")           # the sandbox's own Python
        token = os.environ["GITHUB_TOKEN"]
        subprocess.run(["git", "remote", "add", "origin", a.repo_url], cwd=repo, check=True)
        # Read the token from the environment at push time; never write it into .git/config.
        subprocess.run(["git", "config", "credential.helper",
                        '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'],
                       cwd=repo, check=True)
        subprocess.run(["git", "push", "-q", "-f", "origin", "main"], cwd=repo, check=True)
        factory = lambda t, n: DaytonaSandbox(a.repo_url, t.id, n, github_token=token, run_id=run_id)

    t0 = time.time()
    results = Engine(repo, make_agent(a), factory).run_all(tasks, parallel=a.parallel)
    md = report(results, a, time.time() - t0, {t.id: t.depends_on for t in tasks})
    (out / "report.md").write_text(md)
    (out / "results.json").write_text(results_to_json(results))
    print(md)
    print(f"Saved to {out}")


if __name__ == "__main__":
    main()
