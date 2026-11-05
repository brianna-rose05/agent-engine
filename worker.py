"""Runs one project from the app: python3 worker.py --project-id <Convex project id>

Reads the project from Convex, creates its own private GitHub repo, plans it, waits for the owner to
approve the plan in the app, then builds it in Daytona sandboxes, streaming every step back to Convex.
Started by the `Worker` workflow, which the app triggers when a project is created, retried
(`resume`), changed (`mode: "change"`, docs/change-requests.md) or quickly edited (`mode: "quick"`, engine/quick.py)."""
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
from engine.project import change_project, resume_project, run_project
from engine.quick import quick_blocked, quick_project
from engine.stacks import NextSupabaseStack
from run_benchmark import load_env

ROOT = Path(__file__).parent
APPROVAL_TIMEOUT_S = 60 * 60
OWNER = "brianna-rose05"
QUICK_BUDGET_USD, QUICK_TURNS = 0.50, 40         # a quick change is one small UI task
# git reads the token from the environment, so it is never written into a URL, a file or a command line
CREDENTIALS = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'


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


def publish_preview(results, repo: Path, repo_url: str, events, deploy=None, merged_before=()) -> None:
    """Once the integration task has merged, deploy main to Vercel and tell the app where it lives (on a
    retry where INT merged earlier, redeploy if anything new merged). Never raises: a preview is a bonus."""
    merged_now = {r.task for r in results if r.status == "merged"}
    if "INT" not in merged_now and not ("INT" in merged_before and merged_now):
        return
    try:
        from engine.deploy import deploy_preview
        r = (deploy or deploy_preview)(repo, project_name=repo_url.rstrip("/").rsplit("/", 1)[-1], log=print)
        if r.status == "ready":
            events.emit("preview_ready", url=r.url)
        elif r.status == "skipped":
            events.emit("preview_skipped", reason=r.reason)
        else:
            events.emit("preview_failed", reason=r.reason)
        print(f"preview: {r.status} {r.url or r.reason}")
    except Exception as e:
        events.emit("preview_failed", reason=f"{type(e).__name__}: {e}"[:300])


def finished(results) -> str:
    """Done when everything merged, or when the integration merged: then the app works, and any screen whose
    own feature failed was rebuilt by the integrator (the board still shows that feature as needing you)."""
    if all(r.status in ("merged", "passed") for r in results):
        return "done"
    return "done" if any(r.task == "INT" and r.status == "merged" for r in results) else "failed"


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
    change = project.get("change") if project.get("mode") == "change" else None
    quick = project.get("quick") if project.get("mode") == "quick" else None
    resume = bool(project.get("resume")) and not change and not quick
    if change and not change.get("text"):
        raise SystemExit("change run without a change request")
    if quick is not None and not quick.get("text"):
        raise SystemExit("quick run without a quick change request")
    if resume or change or quick:               # retry, change or quick change: continue in the project's own repo
        if not project.get("repo"):
            raise SystemExit("nothing to retry or change: this project has no repo yet")
        repo_url, repo = project["repo"], out / "repo"
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "-c", f"credential.helper={CREDENTIALS}", "clone", "-q", repo_url, str(repo)], check=True)
        subprocess.run(["git", "config", "credential.helper", CREDENTIALS], cwd=repo, check=True)
    else:
        repo = stack.build_repo(out / "repo")
        repo_url = create_repo(repo_name(project["name"], a.project_id), token, project["name"])
        subprocess.run(["git", "remote", "add", "origin", repo_url], cwd=repo, check=True)
        subprocess.run(["git", "config", "credential.helper", CREDENTIALS], cwd=repo, check=True)
        subprocess.run(["git", "push", "-q", "-u", "origin", "main"], cwd=repo, check=True)

    from engine.agents.claude_cli import ClaudeCLIAgent
    from engine.sandboxes.daytona_sandbox import DaytonaSandbox
    events = Emitter(backend, JsonlSink(out / "events.jsonl"))
    opts = stack.daytona_options()
    engine = Engine(repo, ClaudeCLIAgent(model=project["model"], budget_usd=a.budget),
                    lambda t, n: DaytonaSandbox(repo_url, t.id, n, github_token=token, run_id=out.name, **opts),
                    events=events)
    referee = ClaudeCLIAgent(model="sonnet", budget_usd=a.budget)       # spec: never graded only by its author
    # wiring every page is one big task: more turns, time and budget (cap $1.00)
    integrator = ClaudeCLIAgent(model=project["model"], max_turns=90, budget_usd=min(1.00, a.budget * 2),
                                timeout_s=45 * 60)
    status = "failed"
    results = []
    try:
        if quick:                               # one UI task, the whole-app check, no plan or approval
            agent = ClaudeCLIAgent(model=project["model"], max_turns=QUICK_TURNS, budget_usd=min(QUICK_BUDGET_USD, a.budget))
            results = quick_project(int(quick["n"]), quick["text"], repo, engine, stack, agent=agent)
            status = "blocked" if quick_blocked(results) else finished(results)
            return
        if change:                              # plan only the change, wait for approval, build it in the same repo
            planned, results = change_project(int(change["n"]), change["text"], project["description"], repo, engine,
                                              approve=wait_for_decision(backend.project), stack=stack,
                                              parallel=stack.parallel, save_tests=out / "hidden_tests",
                                              referee=referee, integrator=integrator)
            status = "failed" if planned is None else "rejected" if len(results) == 1 else finished(results)
            return
        if resume:
            plan = json.loads((repo / "plan.json").read_text())
            results = resume_project(plan, project["description"], repo, engine, set(project.get("merged") or []),
                                     stack=stack, parallel=stack.parallel, save_tests=out / "hidden_tests",
                                     referee=referee, integrator=integrator)
            status = finished(results)
            return
        plan, results = run_project(project["description"], repo, engine, "python3",
                                    parallel=stack.parallel, approve=wait_for_decision(backend.project), stack=stack,
                                    save_tests=out / "hidden_tests", referee=referee, integrator=integrator)
        if plan is None:
            status = "failed"
        elif len(results) == 1:
            status = "rejected"
        else:
            status = finished(results)
    finally:
        events.emit("project_finished", status=status, repo=repo_url)
        print(f"project {a.project_id}: {status} ({repo_url})")
        # a rejected change merged (and reverted) only its plan: nothing new to deploy
        publish_preview(results if status != "rejected" else [], repo, repo_url, events,
                        merged_before=set(project.get("merged") or []))
        if status not in ("done", "rejected", "blocked"):     # blocked: a quick change that needs a change request
            sys.exit(1)


if __name__ == "__main__":
    main()
