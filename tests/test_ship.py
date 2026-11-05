"""Ship to production (engine/ship.py, docs/ship.md): version tags with real git and a bare remote, the checks in
a fake sandbox, provisioning and deploys as fakes, and worker.main in mode ship without network."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

import engine.ship
from engine.deploy import DeployResult, deploy_production, production_name
from engine.events import Emitter, ListSink
from engine.interfaces import ExecResult
from engine.ship import (CHECKS, DETAIL_CHARS, ShipError, check_commands, create_version_tag, next_version,
                         plan_pages, run_checks, run_ship, version_sha)
from engine.stacks import NextSupabaseStack
from tests.test_deploy import FakeVercel

ADMIN = "postgresql://owner:pw-Sup3rSecret@ep-x-pooler.neon.tech/neondb?sslmode=require"
SLUG = "studio-garden-ab12cd"
PAGES = ["/", "/book"]


def sh(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def commit(repo: Path, files: dict, msg: str) -> str:
    for path, body in files.items():
        f = repo / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)
        sh(["add", path], repo)
    sh(["commit", "-qm", msg], repo)
    return sh(["rev-parse", "HEAD"], repo)


@pytest.fixture
def repos(tmp_path):
    """(clone, bare remote) with one commit on main, pushed."""
    bare, work = tmp_path / "remote.git", tmp_path / "work"
    sh(["init", "-q", "--bare", "-b", "main", str(bare)], tmp_path)
    sh(["init", "-q", "-b", "main", str(work)], tmp_path)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false")):
        sh(["config", k, v], work)
    commit(work, {"plan.json": json.dumps({"tasks": [], "pages": PAGES}), "src/a.ts": "a1"}, "init")
    sh(["remote", "add", "origin", str(bare)], work)
    sh(["push", "-q", "-u", "origin", "main"], work)
    return work, bare


class FakeBox:
    """A sandbox: `fail` maps a command fragment to the (code, output) it returns; everything else passes."""

    def __init__(self, fail=None, long=True):
        self.fail = fail or {}
        self.cmds = []
        self.entered = self.exited = False
        if not long:
            self.exec_long = None

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *exc):
        self.exited = True

    def exec(self, cmd, timeout=600, env=None):
        self.cmds.append(cmd)
        for frag, (code, out) in self.fail.items():
            if frag in cmd:
                return ExecResult(code, out)
        return ExecResult(0, "ok")

    def exec_long(self, cmd, timeout, env=None, **kw):
        return self.exec(cmd, timeout, env)


def collect():
    sink = ListSink()
    return sink, Emitter(sink).emit


def events(sink):
    return [(e.kind, e.data) for e in sink.events]


# -------------------------------------------------------------------- versions
def test_versions_are_numbered_annotated_tags_pushed_and_never_moved(repos):
    work, bare = repos
    sh(["tag", "v2-beta"], work)                                  # not a version
    sh(["tag", "checkpoint-4"], work)
    assert next_version(work) == 1
    v1 = create_version_tag(work, 1)
    assert v1 == {"n": 1, "tag": "v1", "sha": sh(["rev-parse", "main"], work)}
    assert sh(["cat-file", "-t", "v1"], work) == "tag"            # annotated
    assert sh(["tag", "-l", "--format=%(contents:subject)", "v1"], work) == "Version 1"
    assert version_sha(bare, 1) == v1["sha"]                      # pushed
    new = commit(work, {"src/a.ts": "a2"}, "change")
    assert next_version(work) == 2
    with pytest.raises(ShipError):
        create_version_tag(work, 1)                               # never moved
    assert version_sha(work, 1) == v1["sha"]
    v2 = create_version_tag(work, 2)
    assert v2["sha"] == new and version_sha(bare, 2) == new
    assert version_sha(work, 9) is None


def test_a_fresh_clone_numbers_after_the_tags_on_the_remote(repos, tmp_path):
    work, bare = repos
    create_version_tag(work, 1)
    create_version_tag(work, 2)
    clone = tmp_path / "clone"
    sh(["clone", "-q", str(bare), str(clone)], tmp_path)
    assert next_version(clone) == 3


def test_a_tag_that_cannot_be_pushed_is_removed_locally(repos, tmp_path):
    work, _ = repos
    sh(["remote", "set-url", "origin", str(tmp_path / "missing.git")], work)
    with pytest.raises(ShipError, match="couldn't push v1"):
        create_version_tag(work, 1)
    assert version_sha(work, 1) is None and next_version(work) == 1


# -------------------------------------------------------------------- checks
def test_check_commands_are_the_stack_integration_check_in_order():
    cmds = check_commands(NextSupabaseStack(link_node_modules=False), ["/", "/staff/schedule"])
    assert cmds == [
        ("types", "Types check", "npx tsc --noEmit -p ."),
        ("lint", "Lint", "npx eslint --max-warnings=0 src/app"),
        ("tests", "All tests pass", "NO_COLOR=1 npx vitest run"),
        ("build", "Production build", "NEXT_TELEMETRY_DISABLED=1 npx next build"),
        ("pages", "Every page loads", "node scripts/check-app.mjs / /staff/schedule"),
    ]


def test_plan_pages_reads_plan_json_and_falls_back_to_home(tmp_path):
    (tmp_path / "plan.json").write_text(json.dumps({"pages": ["/", "/book", 3]}))
    assert plan_pages(tmp_path) == ["/", "/book"]
    (tmp_path / "plan.json").write_text("not json")
    assert plan_pages(tmp_path) == ["/"]


@pytest.mark.parametrize("long", [True, False])
def test_checks_run_in_order_and_all_pass(long):
    sink, emit = collect()
    box = FakeBox(long=long)
    stack = NextSupabaseStack(link_node_modules=False)
    assert run_checks(box, stack, PAGES, emit) is None
    assert box.cmds == [c for _, _, c in check_commands(stack, PAGES)]
    got = [(d["name"], d["status"]) for k, d in events(sink)]
    assert got == [(n, s) for n, _ in CHECKS for s in ("running", "passed")]
    assert all("detail" not in d for _, d in events(sink))


def test_checks_stop_at_the_first_failure_with_a_short_scrubbed_detail(monkeypatch):
    monkeypatch.setenv("VERCEL_TOKEN", "vtok-abcdef123456")
    noise = "x" * 5000
    out = f"{noise}\n\x1b[31msrc/app/page.tsx(3,1): error TS2322\x1b[0m using {ADMIN} and vtok-abcdef123456"
    sink, emit = collect()
    box = FakeBox(fail={"npx eslint": (1, out)})
    assert run_checks(box, NextSupabaseStack(link_node_modules=False), PAGES, emit, (ADMIN,)) == "lint"
    assert len(box.cmds) == 2                                    # nothing after lint ran
    got = events(sink)
    assert [(d["name"], d["status"]) for _, d in got] == [("types", "running"), ("types", "passed"),
                                                          ("lint", "running"), ("lint", "failed")]
    detail = got[-1][1]["detail"]
    assert len(detail) <= DETAIL_CHARS and "error TS2322" in detail and "\x1b" not in detail
    assert "pw-Sup3rSecret" not in detail and "vtok-abcdef123456" not in detail and "neon.tech" not in detail


# -------------------------------------------------------------------- run_ship
class Fakes:
    def __init__(self, fail_provision=False, deploy=DeployResult("ready", "https://garden-ab12cd.vercel.app")):
        self.provisioned, self.deployed = [], []
        self.fail_provision = fail_provision
        self.result = deploy
        self.box = FakeBox()

    def provision(self, admin, slug):
        if self.fail_provision:
            raise RuntimeError(f"could not connect to {admin}")
        self.provisioned.append(slug)
        return f"postgresql://owner:pw-Sup3rSecret@ep-x.neon.tech/{engine.ship.database_name(slug)}"

    def deploy(self, repo, slug, ref, env, log=None):
        self.deployed.append({"slug": slug, "ref": ref, "env": env,
                              "files": sh(["ls-tree", "-r", "--name-only", ref], repo).split()})
        return self.result


def ship(work, f, rollback_to=None, admin=ADMIN):
    sink, emit = collect()
    status = run_ship(work, SLUG, emit, stack=NextSupabaseStack(link_node_modules=False), rollback_to=rollback_to,
                      open_box=lambda: f.box, admin_url=admin, provision=f.provision, deploy=f.deploy,
                      log=lambda m: None)
    return status, events(sink)


def no_secrets(evs):
    text = json.dumps(evs)
    return "pw-Sup3rSecret" not in text and "postgresql://" not in text and "neon.tech" not in text


def test_a_new_ship_checks_provisions_tags_and_deploys_the_tag(repos):
    work, bare = repos
    f = Fakes()
    status, evs = ship(work, f)
    assert status == "live"
    kinds = [k for k, _ in evs]
    assert kinds == ["ship_started"] + ["ship_check"] * 10 + ["ship_live"]
    assert evs[0][1] == {"version": None, "rollback": False}
    sha = sh(["rev-parse", "main"], work)
    assert f.box.cmds[0] == f"git checkout -q {sha}" and f.box.exited          # checks ran on the tagged commit
    assert f.provisioned == [f"{SLUG}-prod"]
    assert f.deployed[0]["ref"] == "v1" and f.deployed[0]["slug"] == SLUG
    assert set(f.deployed[0]["env"]) == {"DATABASE_URL"}
    live = evs[-1][1]
    assert live == {"url": "https://garden-ab12cd.vercel.app", "version": 1, "tag": "v1", "sha": sha,
                    "rollback": False, "database": "app_studio_garden_ab12cd_prod"}
    assert live["database"].endswith("_prod") and live["database"] != "app_studio_garden_ab12cd"
    assert version_sha(bare, 1) == sha
    assert no_secrets(evs)
    status, evs = ship(work, Fakes())                            # the next ship is v2
    assert status == "live" and evs[-1][1]["tag"] == "v2"


def test_a_failed_check_ships_nothing(repos):
    work, _ = repos
    f = Fakes()
    f.box = FakeBox(fail={"vitest": (1, f"FAIL tests/unit/a.test.ts {ADMIN}")})
    status, evs = ship(work, f)
    assert status == "failed"
    assert evs[-1] == ("ship_failed", {"reason": evs[-1][1]["reason"], "check": "tests"})
    assert "all tests pass" in evs[-1][1]["reason"].lower()
    assert not f.provisioned and not f.deployed and next_version(work) == 1 and f.box.exited
    assert no_secrets(evs)


@pytest.mark.parametrize("case", ["no admin url", "provision fails"])
def test_no_production_database_means_no_ship(repos, case):
    work, _ = repos
    f = Fakes(fail_provision=case == "provision fails")
    status, evs = ship(work, f, admin="" if case == "no admin url" else ADMIN)
    assert status == "failed" and evs[-1][0] == "ship_failed" and "check" not in evs[-1][1]
    assert "database" in evs[-1][1]["reason"].lower() and len(evs[-1][1]["reason"]) <= 300
    assert not f.deployed and next_version(work) == 1               # no tag either
    assert no_secrets(evs)


def test_a_failed_deploy_is_reported_and_the_tag_stays(repos):
    work, _ = repos
    f = Fakes(deploy=DeployResult("failed", reason="Vercel build error: Command failed"))
    status, evs = ship(work, f)
    assert status == "failed" and evs[-1][0] == "ship_failed" and "Command failed" in evs[-1][1]["reason"]
    assert version_sha(work, 1)                                     # tags are never deleted once pushed


def test_a_sandbox_that_will_not_start_fails_the_ship(repos):
    work, _ = repos
    f = Fakes()

    class Broken(FakeBox):
        def __enter__(self):
            raise RuntimeError("DaytonaError: no capacity")
    f.box = Broken()
    status, evs = ship(work, f)
    assert status == "failed" and [k for k, _ in evs] == ["ship_started", "ship_failed"] and not f.deployed


def test_rollback_redeploys_an_existing_version_without_checks_or_a_new_tag(repos):
    work, _ = repos
    v1 = create_version_tag(work, 1)
    commit(work, {"src/b.ts": "b"}, "later")
    create_version_tag(work, 2)
    f = Fakes()
    status, evs = ship(work, f, rollback_to=1)
    assert status == "live"
    assert [k for k, _ in evs] == ["ship_started", "ship_live"] and not f.box.cmds
    assert evs[0][1] == {"version": 1, "rollback": True}
    assert evs[1][1] == {"url": "https://garden-ab12cd.vercel.app", "version": 1, "tag": "v1", "sha": v1["sha"],
                         "rollback": True, "database": "app_studio_garden_ab12cd_prod"}
    assert f.deployed[0]["ref"] == "v1" and "src/b.ts" not in f.deployed[0]["files"]
    assert next_version(work) == 3 and f.provisioned == [f"{SLUG}-prod"]


def test_rollback_to_a_missing_version_fails(repos):
    work, _ = repos
    f = Fakes()
    status, evs = ship(work, f, rollback_to=4)
    assert status == "failed" and evs[-1][0] == "ship_failed" and "version 4" in evs[-1][1]["reason"]
    assert not f.deployed and not f.provisioned


def test_run_ship_never_raises(repos):
    work, _ = repos
    f = Fakes()

    def boom(*a, **k):
        raise ValueError(f"exploded near {ADMIN}")
    f.deploy = boom
    status, evs = ship(work, f)
    assert status == "failed" and evs[-1][0] == "ship_failed" and no_secrets(evs)


# -------------------------------------------------------------------- deploy_production
def test_production_name_is_never_the_preview_project():
    assert production_name("studio-pawfect-grooming-7-8hjcmv") == "pawfect-grooming-7-8hjcmv"
    assert production_name("garden") == "garden-prod"


def test_deploy_production_uses_its_own_project_and_the_tag_files(repos):
    work, _ = repos
    create_version_tag(work, 1)
    commit(work, {"src/a.ts": "a2-unshipped"}, "later")
    http = FakeVercel(states=("READY",))
    r = deploy_production(work, SLUG, ref="v1", env={"DATABASE_URL": "postgresql://u:pw@h/app_x_prod"},
                          token="tok_secret_123", team_id="team_1", http=http, sleep=lambda s: None)
    assert r.status == "ready"
    created = [json.loads(b) for m, u, h, b in http.calls if m == "POST" and "/v11/projects" in u]
    assert created == [{"name": "garden-ab12cd", "framework": "nextjs"}]
    dep = next(json.loads(b) for m, u, h, b in http.calls if m == "POST" and "/v13/deployments" in u)
    assert dep["project"] == "garden-ab12cd"
    assert b"a1" in http.uploaded.values() and b"a2-unshipped" not in http.uploaded.values()
    envs = [i for m, u, h, b in http.calls if m == "POST" and u.split("?")[0].endswith("/env") for i in json.loads(b)]
    assert {i["key"] for i in envs if i["type"] == "sensitive"} == {"DATABASE_URL", "APP_SESSION_SECRET"}


# -------------------------------------------------------------------- worker.main, mode ship
def run_worker(monkeypatch, tmp_path, bare, ship_row, box=None, fakes=None):
    import worker
    sent = []

    class FakeBackend:
        def __init__(self, project_id):
            pass

        def project(self):
            return {"status": "starting", "mode": "ship", "ship": ship_row, "versions": [], "resume": False,
                    "change": None, "repo": str(bare), "merged": ["INT"], "name": "x", "model": "haiku"}

        def write(self, e):
            sent.append((e.kind, e.data))

    f = fakes or Fakes()
    upgraded, previews = [], []
    monkeypatch.setattr(worker, "upgrade_template", lambda repo, stack: upgraded.append(len(sent)) or [])
    monkeypatch.setattr(worker, "ConvexBackend", FakeBackend)
    monkeypatch.setattr(worker, "ROOT", tmp_path / "worker")
    monkeypatch.setattr(worker, "ship_sandbox", lambda *a: box or f.box)
    monkeypatch.setattr(worker, "publish_preview", lambda *a, **k: previews.append(a))
    monkeypatch.setattr(engine.ship, "provision_database", f.provision)
    monkeypatch.setattr(engine.ship, "deploy_production", f.deploy)
    for k in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setenv("POSTGRES_ADMIN_URL", ADMIN)
    monkeypatch.setattr(sys, "argv", ["worker.py", "--project-id", "p1"])
    code = 0
    try:
        worker.main()
    except SystemExit as e:
        code = e.code
    return code, sent, upgraded, previews, f


def test_worker_ship_mode_end_to_end_without_network(repos, tmp_path, monkeypatch):
    work, bare = repos
    code, sent, upgraded, previews, f = run_worker(monkeypatch, tmp_path, bare, {"from": "done", "rollbackTo": None})
    kinds = [k for k, _ in sent]
    assert code == 0
    assert kinds == ["ship_started"] + ["ship_check"] * 10 + ["ship_live", "project_finished"]
    assert sent[-1][1] == {"status": "done", "repo": str(bare)}
    assert sent[-2][1]["tag"] == "v1" and sent[-2][1]["database"] == "app_remote_git_prod"
    assert upgraded == [0]                                       # the template update came before the tag
    assert version_sha(bare, 1) == sh(["rev-parse", "main"], bare)
    assert f.deployed[0]["ref"] == "v1" and not previews         # the preview is untouched
    assert no_secrets(sent)


def test_worker_ship_mode_failure_still_finishes_done_and_exits_1(repos, tmp_path, monkeypatch):
    work, bare = repos
    box = FakeBox(fail={"next build": (1, "Build error")})
    code, sent, _, previews, f = run_worker(monkeypatch, tmp_path, bare, {"from": "done", "rollbackTo": None}, box=box)
    assert code == 1
    assert [k for k, _ in sent][-2:] == ["ship_failed", "project_finished"]
    assert sent[-2][1]["check"] == "build" and sent[-1][1] == {"status": "done", "repo": str(bare)}
    assert not f.deployed and not previews and version_sha(bare, 1) is None


def test_worker_rollback_ship_mode_end_to_end_without_network(repos, tmp_path, monkeypatch):
    work, bare = repos
    v1 = create_version_tag(work, 1)
    commit(work, {"src/b.ts": "b"}, "later")
    sh(["push", "-q", "origin", "main"], work)
    create_version_tag(work, 2)
    code, sent, upgraded, previews, f = run_worker(monkeypatch, tmp_path, bare, {"from": "done", "rollbackTo": 1.0})
    assert code == 0
    assert [k for k, _ in sent] == ["ship_started", "ship_live", "project_finished"]
    assert sent[0][1] == {"version": 1, "rollback": True}
    assert sent[1][1]["sha"] == v1["sha"] and sent[1][1]["rollback"] is True
    assert upgraded == [] and not f.box.cmds and not previews     # no template update, checks or preview
    assert f.deployed[0]["ref"] == "v1"
    assert sh(["tag", "-l", "v*"], bare).split() == ["v1", "v2"]  # no new tag


def test_worker_rollback_ship_to_a_missing_tag_fails(repos, tmp_path, monkeypatch):
    work, bare = repos
    code, sent, _, _, f = run_worker(monkeypatch, tmp_path, bare, {"from": "done", "rollbackTo": 3})
    assert code == 1 and [k for k, _ in sent] == ["ship_started", "ship_failed", "project_finished"]
    assert not f.deployed
