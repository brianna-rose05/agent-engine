"""Ship to production: check the whole app, give production its own database, tag the version, deploy it.
See docs/ship.md.

    status = run_ship(repo, "studio-garden-ab12cd", events.emit, stack=stack, open_box=lambda: DaytonaSandbox(...))
    # -> "live" or "failed"; every step is an event (ship_started, ship_check..., ship_live | ship_failed)

A new ship runs five checks in one sandbox on main (no agents, no model spend), stopping at the first that
fails; then provisions the production database `app_<slug>_prod` (POSTGRES_ADMIN_URL is required: production
never runs on the in-memory local mode); then tags main as the next version `v<n>` (annotated, pushed, never
forced, moved or deleted once pushed); then deploys that tag to the production Vercel project.
A rollback (`rollback_to=n`) skips the checks and the tagging and deploys the existing tag `v<n>`.

Connection strings, passwords and tokens never reach an event or a log line: everything is scrubbed.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Callable

from engine.databases import database_name, provision_database
from engine.databases import scrub as scrub_urls
from engine.deploy import deploy_production, production_name
from engine.engine import git
from engine.gitlock import repo_lock

TAG_PREFIX = "v"
DETAIL_CHARS = 1500                 # the end of a failed check's output, shown in the app
REASON_CHARS = 300
CHECK_TIMEOUT_S = 15 * 60
BUILD_TIMEOUT_S = 25 * 60
# (name, label) of each check, in order; the commands are the pieces of the stack's integration check
CHECKS = [("types", "Types check"), ("lint", "Lint"), ("tests", "All tests pass"),
          ("build", "Production build"), ("pages", "Every page loads")]
# Values of these settings are scrubbed from everything a ship reports
SECRET_ENV = ("POSTGRES_ADMIN_URL", "VERCEL_TOKEN", "GITHUB_TOKEN", "PROJECTS_GITHUB_TOKEN", "ANTHROPIC_API_KEY",
              "DAYTONA_API_KEY", "CONVEX_DEPLOY_KEY", "BENCH_GITHUB_TOKEN")
TOKEN_RE = re.compile(r"\b(?:gh[pousr]_|github_pat_|sk-ant-|vercel_|dtn_)[A-Za-z0-9_\-]{8,}")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class ShipError(RuntimeError):
    pass


def scrub(text: str, *secrets: str) -> str:
    """Removes connection strings, their passwords, the known settings' values and token-shaped strings."""
    text = scrub_urls(str(text), *[s for s in secrets if s and "://" in s])
    for value in [*secrets, *(os.environ.get(k, "") for k in SECRET_ENV)]:
        if value and len(value) >= 6:
            text = text.replace(value, "***")
    return TOKEN_RE.sub("***", scrub_urls(text, os.environ.get("POSTGRES_ADMIN_URL", "")))


# -------------------------------------------------------------------- checks
def check_commands(stack, pages: list[str]) -> list[tuple[str, str, str]]:
    """(name, label, command) per check, split from the stack's own integration check so the two never drift."""
    parts = [p.strip() for p in stack.integration_check_cmd(pages).split(" && ")]
    if len(parts) != len(CHECKS):
        raise ShipError(f"expected {len(CHECKS)} checks in the stack's integration check, found {len(parts)}")
    return [(name, label, cmd) for (name, label), cmd in zip(CHECKS, parts)]


def plan_pages(repo: Path) -> list[str]:
    """The app's pages, as the integration check uses them (plan.json, updated by every change); ["/"] if none."""
    try:
        plan = json.loads((Path(repo) / "plan.json").read_text())
        pages = [r for r in plan.get("pages", []) if isinstance(r, str)]
    except Exception:
        pages = []
    return pages or ["/"]


def _tail(output: str, *secrets: str) -> str:
    text = scrub(ANSI_RE.sub("", output or "").strip(), *secrets)
    return text[-DETAIL_CHARS:]


def run_checks(box, stack, pages: list[str], emit: Callable, secrets: tuple[str, ...] = ()) -> str | None:
    """Runs the checks in order in `box` (a sandbox on the version to ship), emitting ship_check running, then
    passed or failed, for each. Stops at the first failure. Returns the failed check's name, or None."""
    run = getattr(box, "exec_long", None)
    for name, label, cmd in check_commands(stack, pages):
        emit("ship_check", name=name, label=label, status="running")
        timeout = BUILD_TIMEOUT_S if name == "build" else CHECK_TIMEOUT_S
        try:
            r = run(cmd, timeout=timeout) if run else box.exec(cmd, timeout=timeout)
            code, output = r.code, r.output
        except Exception as e:                  # the sandbox itself failed: this check didn't pass
            code, output = 1, f"{type(e).__name__}: {e}"
        if code != 0:
            emit("ship_check", name=name, label=label, status="failed", detail=_tail(output, *secrets))
            return name
        emit("ship_check", name=name, label=label, status="passed")
    return None


# -------------------------------------------------------------------- versions
def _has_remote(repo: Path) -> bool:
    return bool(git(["remote"], repo).stdout.strip())


def versions(repo: Path) -> list[int]:
    out = git(["tag", "-l", f"{TAG_PREFIX}*"], Path(repo)).stdout
    return sorted(int(m.group(1)) for t in out.split() if (m := re.fullmatch(rf"{TAG_PREFIX}(\d+)", t.strip())))


def next_version(repo: Path) -> int:
    """One more than the highest existing v<n> tag (a fresh clone has them all); 1 for the first ship."""
    return max(versions(repo), default=0) + 1


def version_sha(repo: Path, n: int) -> str | None:
    """The commit tag v<n> points at, or None if there is no such tag."""
    r = git(["rev-parse", "--verify", "-q", f"refs/tags/{TAG_PREFIX}{n}^{{commit}}"], Path(repo))
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def create_version_tag(repo: Path, n: int, sha: str | None = None) -> dict:
    """Annotated tag v<n> ("Version <n>") on `sha` (default: main), pushed without force. An existing tag is never moved; a tag
    that can't be pushed is deleted locally again and ShipError raised, so a version the app hears about always
    exists in the project's repo. Returns {n, tag, sha}."""
    repo = Path(repo)
    tag = f"{TAG_PREFIX}{n}"
    with repo_lock(repo):
        if version_sha(repo, n):
            raise ShipError(f"version {n} already exists")
        sha = git(["rev-parse", "--verify", f"{sha or 'main'}^{{commit}}"], repo).stdout.strip()
        if not sha:
            raise ShipError("the repo has no main branch to ship")
        r = git(["tag", "-a", tag, "-m", f"Version {n}", sha], repo)
        if r.returncode:
            raise ShipError(f"couldn't tag {tag}: {r.stderr.strip()[:200]}")
        if _has_remote(repo):
            r = git(["push", "-q", "origin", f"refs/tags/{tag}"], repo)
            if r.returncode:
                git(["tag", "-d", tag], repo)
                raise ShipError(f"couldn't push {tag}: {r.stderr.strip()[:200]}")
        return {"n": n, "tag": tag, "sha": sha}


# -------------------------------------------------------------------- the whole ship
def run_ship(repo: Path, slug: str, emit: Callable, *, stack=None, rollback_to: int | None = None,
             open_box: Callable[[], object] | None = None, admin_url: str | None = None,
             provision: Callable[[str, str], str] | None = None, deploy: Callable | None = None,
             log: Callable[[str], None] = print) -> str:
    """The worker's ship mode. `slug` is the repo name (the preview's Vercel project and database use it too).
    `open_box()` returns a sandbox context manager on main (new ship only); `provision(admin_url, name)` and
    `deploy(repo, slug, ref=, env=)` default to the real ones. Returns "live" or "failed"; never raises."""
    repo = Path(repo)
    admin = (admin_url if admin_url is not None else os.environ.get("POSTGRES_ADMIN_URL", "")).strip()
    secrets: list[str] = [admin]
    rollback = rollback_to is not None
    emit("ship_started", version=int(rollback_to) if rollback else None, rollback=rollback)

    def fail(reason: str, check: str | None = None) -> str:
        reason = scrub(reason, *secrets)[:REASON_CHARS]
        emit("ship_failed", reason=reason, **({"check": check} if check else {}))
        log(f"ship: failed ({reason})")
        return "failed"

    try:
        # 1. which version, and (new ship) are its checks green?
        if rollback:
            n = int(rollback_to)
            sha = version_sha(repo, n)
            if not sha:
                return fail(f"There is no version {n} to roll back to.")
            version = {"n": n, "tag": f"{TAG_PREFIX}{n}", "sha": sha}
        else:
            if open_box is None:
                return fail("No sandbox is available to run the checks.")
            pages = plan_pages(repo)
            sha = git(["rev-parse", "--verify", "main^{commit}"], repo).stdout.strip()
            if not sha:
                return fail("The repo has no main branch to ship.")
            box_cm = open_box()
            try:
                box = box_cm.__enter__()
            except Exception as e:
                return fail(f"Couldn't start a sandbox to run the checks ({type(e).__name__}: {e}).")
            try:
                # check exactly the commit that gets tagged
                moved = box.exec(f"git checkout -q {sha}", timeout=120)
                if moved.code != 0:
                    return fail("The version to ship isn't on GitHub yet (main wasn't pushed). Try again.")
                failed = run_checks(box, stack, pages, emit, tuple(secrets))
            finally:
                try:
                    box_cm.__exit__(None, None, None)
                except Exception as e:      # the sandbox deletes itself when idle; the ship goes on
                    log(f"ship: couldn't delete the check sandbox ({type(e).__name__}); check the Daytona dashboard")
            if failed:
                label = dict(CHECKS).get(failed, failed)
                return fail(f"The {label.lower()} check failed, so nothing was shipped. Fix it and ship again.",
                            check=failed)

        # 2. production's own database (never the preview's, never the in-memory local mode)
        if not admin:
            return fail("Production needs its own database, and POSTGRES_ADMIN_URL is not set. "
                        "Add it (docs/databases.md) and ship again.")
        db_name = database_name(f"{slug}-prod")
        try:
            db_url = (provision or provision_database)(admin, f"{slug}-prod")
        except Exception as e:
            return fail(f"Couldn't create the production database: {e or type(e).__name__}")
        secrets.append(db_url)
        log(f"ship: database {db_name} ready")

        # 3. the version tag (new ship only; a rollback redeploys an existing one)
        if not rollback:
            try:
                version = create_version_tag(repo, next_version(repo), sha)
            except Exception as e:
                return fail(f"Couldn't save the version in the repo: {e}")
            log(f"ship: tagged {version['tag']} at {version['sha'][:12]}")

        # 4. deploy that tag to production
        r = (deploy or deploy_production)(repo, slug, ref=version["tag"], env={"DATABASE_URL": db_url}, log=log)
        if r.status != "ready":
            what = "Production can't be deployed" if r.status == "skipped" else "The production deploy failed"
            return fail(f"{what}: {r.reason or r.status}")
        emit("ship_live", url=r.url, version=version["n"], tag=version["tag"], sha=version["sha"],
             rollback=rollback, database=db_name)
        log(f"ship: {version['tag']} live at {r.url} (Vercel project {production_name(slug)})")
        return "live"
    except Exception as e:                      # never raise out of a ship: the worker must still finish
        return fail(f"Shipping stopped unexpectedly ({type(e).__name__}: {e}).")
