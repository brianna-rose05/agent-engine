"""Build a whole project from a description, with no human in the loop:
    python3 run_project.py --agent scripted                       # free, offline (tool library fixture)
    python3 run_project.py --agent claude-cli --sandbox daytona --repo-url URL \
        --description projects/samples/community_garden.md --model haiku --budget 0.50

Writes results/<time>-project-.../report.md, plan.json, results.json and the finished repo."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from engine.engine import Engine, results_to_json
from engine.project import build_project_repo, run_project
from run_benchmark import load_env, map_secret_names, money, preflight, report

ROOT = Path(__file__).parent
FIXTURE = ROOT / "projects" / "tool_library"


def make_agent(a):
    if a.agent == "scripted":
        from engine.agents.scripted import ScriptedTeam
        return ScriptedTeam(ROOT / "projects" / "web_bookings" if a.stack == "next-supabase" else FIXTURE)
    if a.agent == "claude-sdk":
        from engine.agents.claude_sdk import ClaudeSDKAgent
        return ClaudeSDKAgent(model=a.model, budget_usd=a.budget)
    from engine.agents.claude_cli import ClaudeCLIAgent
    return ClaudeCLIAgent(model=a.model, budget_usd=a.budget)


def stage_costs(results) -> str:
    stage = lambda r: "plan" if r.task == "PLAN" else ("QA tests" if r.task.endswith("-qa") else "build")
    totals: dict[str, float] = {}
    for r in results:
        totals[stage(r)] = totals.get(stage(r), 0) + r.cost_usd
    return ", ".join(f"{k} {money(v)}" for k, v in totals.items())


def plan_section(plan) -> str:
    if not plan:
        return "\n## Plan\n\nNo valid plan was produced, so nothing was built.\n"
    rows = "\n".join(f"| {t['id']} | {t['title']} | {t['module']} | {', '.join(t.get('depends_on', [])) or '-'} |"
                     for t in plan["tasks"])
    return (f"\n## Plan: {plan['project']}\n\nShared contract: {', '.join(plan['contracts']) or 'none'}\n\n"
            f"| Task | Title | Module | Depends on |\n| --- | --- | --- | --- |\n{rows}\n")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agent", default="scripted", choices=["scripted", "claude-sdk", "claude-cli"])
    p.add_argument("--sandbox", default="local", choices=["local", "daytona"])
    p.add_argument("--description", help="project description file (default: the stack's sample fixture)")
    p.add_argument("--model", default="haiku")
    p.add_argument("--budget", type=float, default=0.50, help="max USD per agent attempt")
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--repo-url")
    p.add_argument("--stack", default="python", choices=["python", "next-supabase"])
    a = p.parse_args()

    load_env(ROOT / ".env")
    map_secret_names()
    if problems := preflight(a):
        print("Not ready to run:\n- " + "\n- ".join(problems))
        sys.exit(2)
    default_desc = ROOT / "projects" / ("web_bookings" if a.stack == "next-supabase" else "tool_library") / "description.md"
    description = Path(a.description or default_desc).read_text()

    run_id = f"{datetime.now():%Y%m%d-%H%M%S}"
    out = ROOT / "results" / f"{run_id}-project-{a.agent}-{a.sandbox}"
    from engine.stacks import NextSupabaseStack, PythonStack
    if a.stack == "next-supabase":
        stack = NextSupabaseStack(link_node_modules=a.sandbox == "local")
    else:
        stack = PythonStack(sys.executable if a.sandbox == "local" else "python3")
    repo = build_project_repo(out / "repo", stack)
    if a.sandbox == "local":
        from engine.sandboxes.local_worktree import LocalWorktreeSandbox
        python, factory = sys.executable, lambda t, n: LocalWorktreeSandbox(repo, t.id, n)
    else:
        from engine.sandboxes.daytona_sandbox import DaytonaSandbox
        python, token = "python3", os.environ["GITHUB_TOKEN"]
        subprocess.run(["git", "remote", "add", "origin", a.repo_url], cwd=repo, check=True)
        subprocess.run(["git", "config", "credential.helper",
                        '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'],
                       cwd=repo, check=True)
        subprocess.run(["git", "push", "-q", "-f", "origin", "main"], cwd=repo, check=True)
        opts = stack.daytona_options()
        factory = lambda t, n: DaytonaSandbox(a.repo_url, t.id, n, github_token=token, run_id=run_id, **opts)

    t0 = time.time()
    plan, results = run_project(description, repo, Engine(repo, make_agent(a), factory), python, a.parallel,
                                stack=stack)
    needs = {t["id"]: t.get("depends_on", []) for t in (plan or {}).get("tasks", [])}
    needs.update({f"{k}-qa": [] for k in list(needs)})
    for k in list(needs):
        if not k.endswith("-qa"):
            needs[k] = [*needs[k], f"{k}-qa"]
    md = report(results, a, time.time() - t0, needs, title="Project report")
    md = md.replace("| Total agent cost |", f"| Cost by stage | {stage_costs(results)} |\n| Total agent cost |")
    md += plan_section(plan)
    (out / "report.md").write_text(md)
    (out / "results.json").write_text(results_to_json(results))
    if plan:
        (out / "plan.json").write_text(json.dumps(plan, indent=2))
    print(md)
    print(f"Saved to {out}")


if __name__ == "__main__":
    main()
