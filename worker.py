"""Runs one project from the web app: python3 worker.py --project-id <uuid>

Reads the project from Supabase, plans it, waits for the owner to approve the plan in the app,
then builds it, streaming every step back to Supabase. Started by the `Worker` workflow."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from engine.engine import Engine
from engine.events import Emitter, JsonlSink
from engine.project import build_project_repo, run_project
from engine.supabase_sink import SupabaseSink
from run_benchmark import load_env, map_secret_names

ROOT = Path(__file__).parent
APPROVAL_TIMEOUT_S = 30 * 60


def fetch_project(project_id: str) -> dict:
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(f"{url}/rest/v1/projects?id=eq.{project_id}&select=*",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        rows = json.loads(r.read())
    if not rows:
        raise SystemExit(f"project {project_id} not found")
    return rows[0]


def wait_for_decision(get_status, poll_s: float = 5, timeout_s: float = APPROVAL_TIMEOUT_S, sleep=time.sleep):
    """Returns an approver for run_project that waits for the user's click in the app."""
    def approve(plan: dict) -> tuple[bool, str]:
        waited = 0.0
        while waited < timeout_s:
            row = get_status()
            if row["status"] == "approved":
                return True, row.get("plan_note") or ""
            if row["status"] == "rejected":
                return False, row.get("plan_note") or "rejected"
            sleep(poll_s)
            waited += poll_s
        return False, f"no decision within {int(timeout_s // 60)} minutes"
    return approve


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project-id", required=True)
    p.add_argument("--repo-url", default="https://github.com/brianna-rose05/paws-bench")
    p.add_argument("--budget", type=float, default=0.50)
    a = p.parse_args()
    load_env(ROOT / ".env")
    map_secret_names()
    missing = [v for v in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "GITHUB_TOKEN", "SUPABASE_URL",
                           "SUPABASE_SERVICE_ROLE_KEY") if not os.environ.get(v)]
    if missing:
        raise SystemExit(f"missing settings: {', '.join(missing)}")

    project = fetch_project(a.project_id)
    if project["status"] != "queued":
        raise SystemExit(f"project is {project['status']}, not queued")
    out = ROOT / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-worker-{a.project_id[:8]}"
    repo = build_project_repo(out / "repo")
    subprocess.run(["git", "remote", "add", "origin", a.repo_url], cwd=repo, check=True)
    subprocess.run(["git", "config", "credential.helper",
                    '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'], cwd=repo, check=True)
    subprocess.run(["git", "push", "-q", "-f", "origin", "main"], cwd=repo, check=True)

    from engine.agents.claude_cli import ClaudeCLIAgent
    from engine.sandboxes.daytona_sandbox import DaytonaSandbox
    run_id = out.name
    events = Emitter(SupabaseSink(a.project_id), JsonlSink(out / "events.jsonl"))
    engine = Engine(repo, ClaudeCLIAgent(model=project["model"], budget_usd=a.budget),
                    lambda t, n: DaytonaSandbox(a.repo_url, t.id, n, github_token=os.environ["GITHUB_TOKEN"],
                                                run_id=run_id), events=events)
    approve = wait_for_decision(lambda: fetch_project(a.project_id))
    try:
        plan, results = run_project(project["description"], repo, engine, "python3", approve=approve)
        if plan is None:
            status = "failed"
        elif len(results) == 1:
            status = "rejected"
        else:
            status = "done" if all(r.status in ("merged", "passed") for r in results) else "failed"
    except Exception:
        events.emit("project_finished", status="failed")
        raise
    events.emit("project_finished", status=status)
    print(f"project {a.project_id}: {status}")
    sys.exit(0 if status in ("done", "rejected") else 1)


if __name__ == "__main__":
    main()
