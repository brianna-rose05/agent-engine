"""Runs one project from the app: python3 worker.py --project-id <Convex project id>

Reads the project from Convex, creates its own private GitHub repo, plans it, waits for the owner to
approve the plan in the app, then builds it in Daytona sandboxes, streaming every step back to Convex.
Started by the `Worker` workflow, which the app triggers when a project is created, retried
(`resume`), changed (`mode: "change"`, docs/change-requests.md), rolled back (`mode: "rollback"`,
docs/checkpoints.md), quickly edited (`mode: "quick"`, engine/quick.py) or shipped to production
(`mode: "ship"`, docs/ship.md)."""
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

from engine import redact
from engine.budget import STOPPED, Budget
from engine.checkpoints import run_rollback, save_checkpoint
from engine.convex_sink import ConvexBackend
from engine.engine import Engine, Result
from engine.events import Emitter, JsonlSink
from engine.pm import saved_ids, ship_ready, write_retro
from engine.project import change_project, resume_project, run_project
from engine.quick import quick_blocked, quick_project
from engine.stacks import NextSupabaseStack, upgrade_template
from run_benchmark import load_env

ROOT = Path(__file__).parent
APPROVAL_TIMEOUT_S = 60 * 60
DEFAULT_PROJECT_BUDGET = 5.00          # $ per project when Convex has none (web/convex/budget.ts BUDGET_DEFAULT)
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


def provision_for_preview(project_name: str, events, provision=None) -> dict | None:
    """The preview's durable database (docs/databases.md) when POSTGRES_ADMIN_URL is set: created on first use,
    found again on every later run. Returns the env for the deploy, or None (local mode). Never raises, and never
    lets a connection string or password reach an event or the log."""
    admin = os.environ.get("POSTGRES_ADMIN_URL", "").strip()
    if not admin:
        return None
    from engine.databases import database_name, provision_database, scrub
    try:
        url = (provision or provision_database)(admin, project_name)
    except Exception as e:
        reason = scrub(str(e) or type(e).__name__, admin)[:300]
        events.emit("database_failed", reason=reason)
        print(f"database: failed ({reason}); deploying in local mode")
        return None
    name = database_name(project_name)
    events.emit("database_ready", name=name)
    print(f"database: {name} ready")
    return {"DATABASE_URL": url}


def project_setup_code(project: dict | None, environment: str) -> str | None:
    """The owner's setup code for "preview" or "production" from the project row (`setupCodes`, docs/owner-setup.md),
    or None when the row has none. The deploy sets it as APP_SETUP_CODE; it is never printed or emitted."""
    codes = (project or {}).get("setupCodes")
    code = codes.get(environment) if isinstance(codes, dict) else None
    return code.strip() if isinstance(code, str) and code.strip() else None


ANTHROPIC_KEY_PREFIX = "sk-ant-"        # web/convex/apiKey.ts checkAnthropicKey


def project_anthropic_key(project: dict | None) -> str | None:
    """The project's own Anthropic API key (`anthropicKey`, decrypted by projectForWorker; docs/settings.md), or
    None when the row has none or something that isn't a key."""
    key = (project or {}).get("anthropicKey")
    key = key.strip() if isinstance(key, str) else ""
    return key if key.startswith(ANTHROPIC_KEY_PREFIX) and len(key) >= 40 else None


def use_anthropic_key(project: dict | None, environ=os.environ) -> str:
    """Picks the Anthropic key for every agent of this run: the project's own key when it has one, else Studio's
    ANTHROPIC_API_KEY. The chosen key goes in ANTHROPIC_API_KEY, which every ClaudeCLIAgent reads and passes to its
    sandbox command's environment (engine/agents/claude_cli.py), so no agent can end up on the other key. Both keys
    are registered with engine/redact.py, so neither reaches an event, a scrubbed error or stdout/stderr.
    Returns "project" or "studio"; raises SystemExit (without the key) when no key is usable."""
    redact.register(environ.get("ANTHROPIC_API_KEY"))
    problem = (project or {}).get("anthropicKeyProblem")
    if isinstance(problem, str) and problem:
        raise SystemExit(f"this project's own Anthropic API key can't be used: {problem[:300]}")
    own = project_anthropic_key(project)
    if own:
        redact.register(own)
        environ["ANTHROPIC_API_KEY"] = own
        return "project"
    if not environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("missing settings: ANTHROPIC_API_KEY (or give the project its own key in Studio)")
    return "studio"


def hide(text: str, *secrets: str | None) -> str:
    text = redact.redact(text)
    for s in secrets:
        if s:
            text = text.replace(s, "***")
    return text


def publish_preview(results, repo: Path, repo_url: str, events, deploy=None, merged_before=(), provision=None,
                    setup_code: str | None = None) -> None:
    """Once the integration task has merged, deploy main to Vercel and tell the app where it lives (on a
    retry where INT merged earlier, redeploy if anything new merged). With POSTGRES_ADMIN_URL set, the preview
    gets its own durable Postgres first; if that fails it still deploys, in local mode. With a `setup_code` (the
    row's setupCodes.preview) the preview gets it as APP_SETUP_CODE. Never raises: a preview is a bonus."""
    merged_now = {r.task for r in results if r.status == "merged"}
    if "INT" not in merged_now and not ("INT" in merged_before and merged_now):
        return
    try:
        from engine.deploy import deploy_preview
        project_name = repo_url.rstrip("/").rsplit("/", 1)[-1]
        env = provision_for_preview(project_name, events, provision)
        extra = {"env": env} if env else {}
        if setup_code:
            extra["setup_code"] = setup_code
        r = (deploy or deploy_preview)(repo, project_name=project_name, log=print, **extra)
        reason = hide(r.reason or "", setup_code)
        if r.status == "ready":
            events.emit("preview_ready", url=r.url)
        elif r.status == "skipped":
            events.emit("preview_skipped", reason=reason)
        else:
            events.emit("preview_failed", reason=reason)
        print(f"preview: {r.status} {r.url or reason}")
    except Exception as e:
        events.emit("preview_failed", reason=hide(f"{type(e).__name__}: {e}", setup_code)[:300])


def finished(results, deferred=()) -> str:
    """Done when everything merged, or when the integration merged: then the app works, and any screen whose
    own feature failed was rebuilt by the integrator (the board still shows that feature as needing you).
    Features saved for later (`deferred`, docs/pm.md) are never failures.
    Stopped when the spending limit kept work from starting: raise it and retry what's left."""
    results = [r for r in results if r.task.removesuffix("-qa") not in set(deferred or ())]
    if all(r.status in ("merged", "passed") for r in results):
        return "done"
    if any(r.task == "INT" and r.status == "merged" for r in results):
        return "done"
    return STOPPED if any(r.status == STOPPED for r in results) else "failed"


def project_budget(project: dict, emit) -> Budget:
    """The project's spending limit, less what earlier runs (the first build, retries, changes) already spent."""
    limit = float(project.get("budgetUsd") or DEFAULT_PROJECT_BUDGET)
    return Budget(limit, float(project.get("costUsd") or 0.0), emit)


def with_fresh_budget(approve, get_project, budget: Budget):
    """The owner can change the limit on the approval screen while the worker waits: use the limit as it stands
    when they decide, not as it was when the run started."""
    def wrapped(plan: dict) -> tuple[bool, str]:
        decision = approve(plan)
        try:
            limit = float((get_project() or {}).get("budgetUsd") or 0)
        except Exception:                       # keep the limit we have; the build must not die over this
            limit = 0
        budget.set_limit(limit)
        return decision
    return wrapped


def checkpoint_label(change: dict | None, resume: bool, quick: dict | None = None) -> str:
    for kind, item in (("Change", change), ("Quick change", quick)):
        if item:
            text = " ".join(str(item.get("text", "")).split())
            # Convex numbers arrive as floats (2.0): labels show the whole number
            return f"{kind} {int(item['n'])}: {text[:60]}{'…' if len(text) > 60 else ''}"
    return "Retry finished" if resume else "Build finished"


def tech_lead_agents(budget_usd: float):
    """(tech lead, stronger dev): both Sonnet, never Opus. The engine uses the stronger dev only for the tech lead's
    extra tries, and only when the project's own dev model isn't already Sonnet."""
    from engine.agents.claude_cli import ClaudeCLIAgent
    return ClaudeCLIAgent(model="sonnet", budget_usd=budget_usd), ClaudeCLIAgent(model="sonnet", budget_usd=budget_usd)


def reviewer_agent(budget_usd: float):
    """The code reviewer (docs/reviewer.md): Sonnet, a different model from a Haiku dev. When the project's dev is
    Sonnet too, it is still a separate run that never saw the dev's session, so no agent grades its own work."""
    from engine.agents.claude_cli import ClaudeCLIAgent
    return ClaudeCLIAgent(model="sonnet", budget_usd=budget_usd)


def architect_agent(budget_usd: float):
    """The architect (docs/architect.md): Sonnet, a different model from a Haiku planner. It reviews a plan's contracts
    before the owner approves it; on a Sonnet project it is still a separate run that never saw the planner's session."""
    from engine.agents.claude_cli import ClaudeCLIAgent
    return ClaudeCLIAgent(model="sonnet", budget_usd=budget_usd)


def designer_agent(budget_usd: float):
    """The designer (docs/designer.md): Sonnet, a different model from a Haiku dev, and it can read images. It looks at
    screenshots of every page before the integration merges; on a Sonnet project it is still a separate run that never
    saw the integrator's session. A few dozen screenshots at most: fewer turns than a dev."""
    from engine.agents.claude_cli import ClaudeCLIAgent
    return ClaudeCLIAgent(model="sonnet", max_turns=40, budget_usd=budget_usd, timeout_s=20 * 60)


def owner_answers(project: dict) -> dict[str, str]:
    """The owner's answers to the tech lead's questions on the project row (`answers: {taskId: text}`), as plain
    text of at most 2000 characters each; anything else on the row is ignored."""
    raw = project.get("answers")
    if not isinstance(raw, dict):
        return {}
    return {str(k): v.strip()[:2000] for k, v in raw.items() if isinstance(v, str) and v.strip()}


def project_deferred(project: dict | None) -> list[str]:
    """Task ids the owner saved for later on the project row (`deferred`, docs/pm.md); anything else is ignored."""
    raw = (project or {}).get("deferred")
    return [str(d) for d in raw if isinstance(d, str) and d.strip()] if isinstance(raw, list) else []


def fresh_deferred(get_project, chosen: list):
    """run_project's `deferred`: read after approval (the owner picks them on the approval screen), like the
    budget in with_fresh_budget. Records what it read in `chosen`; a failed read saves nothing for later."""
    def read(plan: dict) -> list[str]:
        try:
            ids = project_deferred(get_project())
        except Exception:
            ids = []
        chosen[:] = ids
        return ids
    return read


def read_plan(repo: Path) -> dict | None:
    try:
        plan = json.loads((Path(repo) / "plan.json").read_text())
    except (OSError, ValueError):
        return None
    return plan if isinstance(plan, dict) and isinstance(plan.get("tasks"), list) else None


def pm_after_run(repo: Path, label: str, results, events, *, deferred=(), merged_before=(), cost_usd=None,
                 retro: bool = True) -> list[str]:
    """The PM's deterministic notes once a run's status is known and it isn't rejected (docs/pm.md): the retro
    section (build, retry and change runs; never fails the run). Returns the ids still saved for later."""
    try:
        plan = read_plan(repo)
        merged = set(merged_before) | {r.task for r in results if r.status == "merged"}
        saved = [i for i in saved_ids(plan, deferred) if i not in merged] if plan else []
    except Exception as e:                       # a malformed plan.json: note the run without titles
        print(f"pm: plan unreadable ({type(e).__name__})")
        plan, saved = None, []
    if retro:
        write_retro(repo, label, results, events, plan=plan, deferred=saved, cost_usd=cost_usd)
    return saved


def emit_ready_to_ship(repo: Path, results, events, merged_before=(), needs_int: bool = True) -> dict | None:
    """ready_to_ship {saved, musts} once per finished run when every Must feature is merged (docs/pm.md)."""
    try:
        ready = ship_ready(read_plan(repo), results, merged_before, needs_int)
    except Exception as e:
        print(f"pm: ship gate not checked ({type(e).__name__})")
        return None
    if ready is not None:
        events.emit("ready_to_ship", **ready)
    return ready


def ship_sandbox(repo_url: str, token: str, run_id: str, stack):
    """One web sandbox on main for the ship checks (engine/ship.py runs them; no agent is installed or run)."""
    from engine.sandboxes.daytona_sandbox import DaytonaSandbox
    return DaytonaSandbox(repo_url, "SHIP", 1, github_token=token, run_id=run_id, **stack.daytona_options())


def run_ship_mode(project: dict, backend, out: Path, token: str, stack) -> None:
    """Mode "ship" (docs/ship.md): ship main as the next version, or (ship.rollbackTo) redeploy an earlier
    version to production. Never touches the preview. Always ends with project_finished {status: "done"}:
    shipping never changes whether the app is built. Exits 1 if the ship failed."""
    from engine.ship import run_ship
    ship = project.get("ship") or {}
    rollback_to = ship.get("rollbackTo")
    rollback_to = int(rollback_to) if rollback_to is not None else None
    repo_url, repo = project["repo"], out / "repo"
    out.mkdir(parents=True, exist_ok=True)
    events = Emitter(backend, JsonlSink(out / "events.jsonl"))
    status = "failed"
    try:
        try:
            subprocess.run(["git", "-c", f"credential.helper={CREDENTIALS}", "clone", "-q", repo_url, str(repo)],
                           check=True, capture_output=True)
            subprocess.run(["git", "config", "credential.helper", CREDENTIALS], cwd=repo, check=True)
        except Exception:
            events.emit("ship_started", version=rollback_to, rollback=rollback_to is not None)
            events.emit("ship_failed", reason="Couldn't download the project's repo from GitHub. Try again.")
            return
        if rollback_to is None:                 # before tagging, so the version includes the current template
            try:
                if files := upgrade_template(repo, stack):
                    events.emit("template_updated", files=files)
            except Exception as e:
                print(f"template: not updated ({type(e).__name__})")
        slug = repo_url.rstrip("/").rsplit("/", 1)[-1]        # the repo name, as for previews
        status = run_ship(repo, slug, events.emit, stack=stack, rollback_to=rollback_to,
                          open_box=lambda: ship_sandbox(repo_url, token, out.name, stack),
                          setup_code=project_setup_code(project, "production"))
    finally:
        events.emit("project_finished", status="done", repo=repo_url)
        print(f"project ship: {status} ({repo_url})")
        if status != "live":
            sys.exit(1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project-id", required=True)
    p.add_argument("--budget", type=float, default=0.50)
    a = p.parse_args()
    load_env(ROOT / ".env")
    redact.redact_output()                             # secrets registered below never reach the log
    # ANTHROPIC_API_KEY is checked once the project is read: a project with its own key doesn't need Studio's
    missing = [v for v in ("DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY") if not os.environ.get(v)]
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
    # every agent of this run uses the project's own key when it has one (docs/settings.md); never printed
    source = use_anthropic_key(project)
    print("anthropic key: " + ("the project's own key" if source == "project" else "Studio's key"))

    out = ROOT / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-worker-{a.project_id[-8:]}"
    stack = NextSupabaseStack(link_node_modules=False)
    change = project.get("change") if project.get("mode") == "change" else None
    quick = project.get("quick") if project.get("mode") == "quick" else None
    resume = bool(project.get("resume")) and not change and not quick
    rollback_to = project.get("rollback") if project.get("mode") == "rollback" else None
    if change and not change.get("text"):
        raise SystemExit("change run without a change request")
    if quick is not None and not quick.get("text"):
        raise SystemExit("quick run without a quick change request")
    if project.get("mode") == "ship":           # no agents: checks, a version tag, a production deploy
        if not project.get("repo"):
            raise SystemExit("nothing to ship: this project has no repo yet")
        run_ship_mode(project, backend, out, token, stack)
        return
    template_updated: list[str] = []
    if resume or change or rollback_to or quick:   # retry, change, rollback or quick change: the project's own repo
        if not project.get("repo"):
            raise SystemExit("nothing to retry or change: this project has no repo yet")
        repo_url, repo = project["repo"], out / "repo"
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "-c", f"credential.helper={CREDENTIALS}", "clone", "-q", repo_url, str(repo)], check=True)
        subprocess.run(["git", "config", "credential.helper", CREDENTIALS], cwd=repo, check=True)
        if not rollback_to:                     # a rollback restores old files first; it updates them after
            # A new major version of the template's dependencies only with a change that opts in
            # (docs/template-upgrades.md); every other run keeps the project's own versions.
            template_updated = upgrade_template(repo, stack, dependencies=bool((change or {}).get("upgradeTemplate")))
    else:
        repo = stack.build_repo(out / "repo")
        repo_url = create_repo(repo_name(project["name"], a.project_id), token, project["name"])
        subprocess.run(["git", "remote", "add", "origin", repo_url], cwd=repo, check=True)
        subprocess.run(["git", "config", "credential.helper", CREDENTIALS], cwd=repo, check=True)
        subprocess.run(["git", "push", "-q", "-u", "origin", "main"], cwd=repo, check=True)

    from engine.agents.claude_cli import ClaudeCLIAgent
    from engine.sandboxes.daytona_sandbox import DaytonaSandbox
    events = Emitter(backend, JsonlSink(out / "events.jsonl"))
    if template_updated:
        events.emit("template_updated", files=template_updated)
    if rollback_to:                             # no agents: one commit on main, a new checkpoint, a redeploy
        status = run_rollback(repo, int(rollback_to["n"]), events, merged=project.get("merged") or [])
        events.emit("project_finished", status=status, repo=repo_url)
        print(f"project {a.project_id}: rollback {status} ({repo_url})")
        if status != "done":
            sys.exit(1)
        # the restored tree is a finished app (checkpoints are only made when a run is done): redeploy it, with
        # the current template's files (the checkpoint may predate a template fix)
        if files := upgrade_template(repo, stack):
            events.emit("template_updated", files=files)
        publish_preview([Result("INT", "rollback", "merged")], repo, repo_url, events,
                        setup_code=project_setup_code(project, "preview"))
        return
    opts = stack.daytona_options()
    engine = Engine(repo, ClaudeCLIAgent(model=project["model"], budget_usd=a.budget),
                    lambda t, n: DaytonaSandbox(repo_url, t.id, n, github_token=token, run_id=out.name, **opts),
                    events=events, budget=project_budget(project, events.emit))
    referee = ClaudeCLIAgent(model="sonnet", budget_usd=a.budget)       # spec: never graded only by its author
    # wiring every page is one big task: more turns, time and budget (cap $1.00)
    integrator = ClaudeCLIAgent(model=project["model"], max_turns=90, budget_usd=min(1.00, a.budget * 2),
                                timeout_s=45 * 60)
    # The tech lead reviews a feature whose tries all failed (docs/tech-lead.md): a stronger model than a Haiku dev.
    # Its extra tries run on `stronger_dev` when it asks for a stronger model.
    tech_lead, stronger_dev = tech_lead_agents(a.budget)
    # The code reviewer reads each feature's passing attempt before it merges (docs/reviewer.md).
    reviewer = reviewer_agent(a.budget)
    # The architect reviews the plan's contracts before the owner is asked to approve it (docs/architect.md).
    architect = architect_agent(a.budget)
    # The designer looks at screenshots of every page before the integration merges (docs/designer.md).
    designer = designer_agent(a.budget)
    approve = with_fresh_budget(wait_for_decision(backend.project), backend.project, engine.budget)
    status = "failed"
    results = []
    # Features the owner saved for later (docs/pm.md): a new build reads them after approval; a retry, "Build saved
    # features" (the app clears the list first) and a change read them from the row.
    deferred = project_deferred(project)
    merged_before = set(project.get("merged") or [])
    spent_before = engine.budget.spent
    try:
        if quick:                               # one UI task, the whole-app check, no plan or approval
            agent = ClaudeCLIAgent(model=project["model"], max_turns=QUICK_TURNS, budget_usd=min(QUICK_BUDGET_USD, a.budget))
            results = quick_project(int(quick["n"]), quick["text"], repo, engine, stack, agent=agent)
            status = "blocked" if quick_blocked(results) else finished(results)
            return
        if change:                              # plan only the change, wait for approval, build it in the same repo
            planned, results = change_project(int(change["n"]), change["text"], project["description"], repo, engine,
                                              approve=approve, stack=stack,
                                              parallel=stack.parallel, save_tests=out / "hidden_tests",
                                              referee=referee, integrator=integrator,
                                              tech_lead=tech_lead, stronger_dev=stronger_dev, deferred=deferred,
                                              reviewer=reviewer, architect=architect, designer=designer)
            status = "failed" if planned is None else "rejected" if len(results) == 1 else finished(results, deferred)
            return
        if resume:
            plan = json.loads((repo / "plan.json").read_text())
            results = resume_project(plan, project["description"], repo, engine, merged_before,
                                     stack=stack, parallel=stack.parallel, save_tests=out / "hidden_tests",
                                     referee=referee, integrator=integrator,
                                     tech_lead=tech_lead, stronger_dev=stronger_dev,
                                     answers=owner_answers(project), deferred=deferred, reviewer=reviewer,
                                     designer=designer)
            status = finished(results, deferred)
            return
        deferred = []                           # filled after approval, when the owner has chosen
        plan, results = run_project(project["description"], repo, engine, "python3",
                                    parallel=stack.parallel, approve=approve, stack=stack,
                                    save_tests=out / "hidden_tests", referee=referee, integrator=integrator,
                                    tech_lead=tech_lead, stronger_dev=stronger_dev,
                                    deferred=fresh_deferred(backend.project, deferred), reviewer=reviewer,
                                    architect=architect, designer=designer)
        if plan is None:
            status = "failed"
        elif len(results) == 1:
            status = "rejected"
        else:
            status = finished(results, deferred)
    finally:
        if status == "failed" and engine.budget.stopped:   # e.g. the planner itself was stopped by the limit
            status = STOPPED
        label = checkpoint_label(change, resume, quick)
        if status != "rejected" and not quick:  # retro notes (docs/pm.md), in the checkpoint below; never fail the run
            pm_after_run(repo, label, results, events, deferred=deferred, merged_before=merged_before,
                         cost_usd=engine.budget.spent - spent_before)
        if status == "done":                    # a save point the owner can roll back to (docs/checkpoints.md)
            merged = {*merged_before, *(r.task for r in results if r.status == "merged")}
            save_checkpoint(repo, label, events, merged)
        events.emit("project_finished", status=status, repo=repo_url)
        print(f"project {a.project_id}: {status} ({repo_url})")
        if status == "done":                    # the ship gate: every Must feature passes (docs/pm.md)
            emit_ready_to_ship(repo, results, events, merged_before, needs_int=stack.integration)
        # a rejected change merged (and reverted) only its plan: nothing new to deploy
        publish_preview(results if status != "rejected" else [], repo, repo_url, events,
                        merged_before=set(project.get("merged") or []),
                        setup_code=project_setup_code(project, "preview"))
        if status not in ("done", "rejected", STOPPED, "blocked"):  # stopped at the limit / blocked quick change: the owner's call
            sys.exit(1)


if __name__ == "__main__":
    main()
