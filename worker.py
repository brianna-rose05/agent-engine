"""Runs one project from the app: python3 worker.py --project-id <Convex project id>

Reads the project from Convex, creates its own private GitHub repo, plans it, waits for the owner to
approve the plan in the app, then builds it in Daytona sandboxes, streaming every step back to Convex.
Started by the `Worker` workflow, which the app triggers when a project is created."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from engine.convex_sink import ConvexBackend
from engine.engine import Engine
from engine.events import Emitter, JsonlSink
from engine.project import run_project
from engine.stacks import NextSupabaseStack
from run_benchmark import load_env

ROOT = Path(__file__).parent
APPROVAL_TIMEOUT_S = 60 * 60
OWNER = "brianna-rose05"


def wait_for_decision(get_project, poll_s: float = 5, timeout_s: float = APPROVAL_TIMEOUT_S, sleep=time.sleep):
    """An approver for run_project that waits for the owner's click in the app."""
    def approve(plan: dict) -> tuple[bool, str]:
        waited = 0.0
        while waited < timeout_s:
            row = get_project() or {}
            if row.get("status") == "approved":
                return True, row.get("planNote") or ""
            if row.get("status") == "rejected":
                return False, row.get("planNote") or "rejected"
            sleep(poll_s)
            waited += poll_s
        return False, f"no decision within {int(timeout_s // 60)} minutes"
    return approve


def repo_name(project_name: str, project_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", project_name.lower()).strip("-")[:40] or "project"
    return f"studio-{slug}-{project_id[-6:].lower()}"


def create_repo(name: str, token: str, description: str) -> str:
    """A private repo per project (spec: one GitHub repo per project, owned by the user)."""
    body = json.dumps({"name": name, "private": True, "auto_init": False,
                       "description": description[:300]}).encode()
    req = urllib.request.Request("https://api.github.com/user/repos", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "studio-engine"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["html_url"]
    except urllib.error.HTTPError as e:
        if e.code == 422:                       # already exists (a retried run)
            return f"https://github.com/{OWNER}/{name}"
        raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project-id", required=True)
    p.add_argument("--budget", type=float, default=0.50)
    a = p.parse_args()
    load_env(ROOT / ".env")
    missing = [v for v in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY")
               if not os.environ.get(v)]
    if missing:
        raise SystemExit(f"missing settings: {', '.join(missing)}")
    token = os.environ["PROJECTS_GITHUB_TOKEN"]
    os.environ["GITHUB_TOKEN"] = token                 # read by the git credential helper below

    backend = ConvexBackend(a.project_id)
    project = backend.project()
    if not project:
        raise SystemExit("project not found")
    if project["status"] not in ("queued", "starting"):
        raise SystemExit(f"project is {project['status']}, not waiting to start")

    out = ROOT / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-worker-{a.project_id[-8:]}"
    stack = NextSupabaseStack(link_node_modules=False)
    repo = stack.build_repo(out / "repo")
    repo_url = create_repo(repo_name(project["name"], a.project_id), token, project["name"])
    subprocess.run(["git", "remote", "add", "origin", repo_url], cwd=repo, check=True)
    subprocess.run(["git", "config", "credential.helper",
                    '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'], cwd=repo, check=True)
    subprocess.run(["git", "push", "-q", "-u", "origin", "main"], cwd=repo, check=True)

    from engine.agents.claude_cli import ClaudeCLIAgent
    from engine.sandboxes.daytona_sandbox import DaytonaSandbox
    events = Emitter(backend, JsonlSink(out / "events.jsonl"))
    opts = stack.daytona_options()
    engine = Engine(repo, ClaudeCLIAgent(model=project["model"], budget_usd=a.budget),
                    lambda t, n: DaytonaSandbox(repo_url, t.id, n, github_token=token, run_id=out.name, **opts),
                    events=events)
    status = "failed"
    try:
        plan, results = run_project(project["description"], repo, engine, "python3",
                                    parallel=stack.parallel, approve=wait_for_decision(backend.project), stack=stack)
        if plan is None:
            status = "failed"
        elif len(results) == 1:
            status = "rejected"
        else:
            status = "done" if all(r.status in ("merged", "passed") for r in results) else "failed"
    finally:
        events.emit("project_finished", status=status, repo=repo_url)
    print(f"project {a.project_id}: {status} ({repo_url})")
    sys.exit(0 if status in ("done", "rejected") else 1)


if __name__ == "__main__":
    main()
