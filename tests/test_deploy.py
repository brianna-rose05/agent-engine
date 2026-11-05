"""Preview deploys to Vercel, against a fake HTTP layer (never the real API)."""
import hashlib
import json
import subprocess
from pathlib import Path

from engine.deploy import deploy_preview, excluded, repo_files
from engine.engine import Result
from engine.events import Emitter, ListSink

TOKEN = "tok_secret_123"


class FakeVercel:
    """Records every request; answers like the Vercel API. `states` are the readyStates the polls return."""

    def __init__(self, states=("BUILDING", "READY"), project_exists=False, error_message="Command failed: next build",
                 teams=None, env_keys=(), env_failed=None):
        self.calls = []
        self.env_keys = list(env_keys)
        self.env_failed = env_failed
        self.teams = teams
        self.states = list(states)
        self.project_exists = project_exists
        self.error_message = error_message
        self.uploaded = {}

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        path = url.split("https://api.vercel.com", 1)[1].split("?")[0]
        if method == "GET" and path == "/v2/teams" and self.teams is not None:
            return 200, json.dumps({"teams": self.teams}).encode()
        if method == "GET" and path.startswith("/v9/projects/"):
            return (200, b'{"id":"prj_1"}') if self.project_exists else (404, b'{"error":{"code":"not_found"}}')
        if method == "POST" and path == "/v11/projects":
            return 200, b'{"id":"prj_1"}'
        if method == "GET" and path.endswith("/env"):
            return 200, json.dumps({"envs": [{"key": k, "type": "sensitive", "value": ""} for k in self.env_keys]}).encode()
        if method == "POST" and path.endswith("/env"):
            items = json.loads(body)
            failed = [{"error": {"code": "bad", "envVarKey": i["key"], "value": i["value"],
                                 "message": f"rejected {i['value']}"}} for i in items if i["key"] == self.env_failed]
            return 201, json.dumps({"created": [], "failed": failed}).encode()
        if method == "POST" and path == "/v2/files":
            assert hashlib.sha1(body).hexdigest() == headers["x-vercel-digest"]
            assert headers["Content-Length"] == str(len(body))
            self.uploaded[headers["x-vercel-digest"]] = body
            return 200, b"{}"
        if method == "POST" and path == "/v13/deployments":
            return 200, json.dumps({"id": "dpl_1", "url": "studio-x-abc123-git.vercel.app",
                                    "readyState": "QUEUED"}).encode()
        if method == "GET" and path == "/v13/deployments/dpl_1":
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            d = {"id": "dpl_1", "url": "studio-x-abc123-git.vercel.app", "readyState": state}
            if state == "READY":
                d["alias"] = ["studio-x-abc123.vercel.app", "studio-x-abc123-me.vercel.app"]
            if state == "ERROR":
                d["errorMessage"] = self.error_message
            return 200, json.dumps(d).encode()
        return 404, b'{"error":{"message":"unexpected"}}'

    def find(self, method, path):
        return [c for c in self.calls if c[0] == method and c[1].split("?")[0].endswith(path)]


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "src/app").mkdir(parents=True)
    (repo / "node_modules/next").mkdir(parents=True)
    (repo / "src/app/page.tsx").write_text("export default function P() { return <p>hi</p>; }\n")
    (repo / "package.json").write_text('{"name":"app"}\n')
    (repo / "node_modules/next/index.js").write_text("module.exports = 1\n")
    (repo / ".env").write_text("SECRET=1\n")
    (repo / ".env.local").write_text("SECRET=2\n")
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)  # noqa: E731
    run("init", "-q", "-b", "main")
    run("add", "-f", ".")                      # even if someone force-committed them
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
    return repo


def deploy(repo, http, **kw):
    kw.setdefault("token", TOKEN)
    kw.setdefault("team_id", "")
    return deploy_preview(repo, "studio-x-abc123", http=http, sleep=lambda s: None, **kw)


def test_uploads_files_and_creates_a_production_nextjs_deployment(tmp_path):
    http = FakeVercel()
    r = deploy(make_repo(tmp_path), http)
    assert r.status == "ready", r.reason
    body = json.loads(http.find("POST", "/v13/deployments")[0][3])
    assert body["name"] == body["project"] == "studio-x-abc123"
    assert body["target"] == "production"
    assert body["projectSettings"] == {"framework": "nextjs"}
    files = {f["file"]: f for f in body["files"]}
    assert set(files) == {"src/app/page.tsx", "package.json"}
    for f in files.values():                    # every referenced file was uploaded, with its sha and size
        assert http.uploaded[f["sha"]] and len(http.uploaded[f["sha"]]) == f["size"]
    # new project made as Next.js; telemetry off; never a DATABASE_URL
    assert json.loads(http.find("POST", "/v11/projects")[0][3]) == {"name": "studio-x-abc123", "framework": "nextjs"}
    env = json.loads(http.find("POST", "/env")[0][3])
    assert [(e["key"], e["value"]) for e in env] == [("NEXT_TELEMETRY_DISABLED", "1")]
    assert "upsert=true" in http.find("POST", "/env")[0][1]


def test_polls_until_ready_and_returns_the_stable_production_url(tmp_path):
    http = FakeVercel(states=("QUEUED", "BUILDING", "BUILDING", "READY"))
    r = deploy(make_repo(tmp_path), http)
    assert (r.status, r.url) == ("ready", "https://studio-x-abc123.vercel.app")
    assert len(http.find("GET", "/v13/deployments/dpl_1")) == 4


def test_build_error_returns_the_reason(tmp_path):
    r = deploy(make_repo(tmp_path), FakeVercel(states=("BUILDING", "ERROR")))
    assert r.status == "failed"
    assert "Command failed: next build" in r.reason


def test_times_out_with_a_clear_reason(tmp_path):
    t = iter(range(0, 10_000, 60))
    r = deploy(make_repo(tmp_path), FakeVercel(states=("BUILDING",)), clock=lambda: next(t), timeout_s=600)
    assert r.status == "failed" and "not ready after 10 minutes" in r.reason


def test_api_error_is_a_failed_result_without_the_token(tmp_path):
    def http(method, url, headers, body):
        return 403, json.dumps({"error": {"message": f"bad token {TOKEN}"}}).encode()
    r = deploy(make_repo(tmp_path), http)
    assert r.status == "failed" and "403" in r.reason
    assert TOKEN not in r.reason


def test_no_token_skips_without_calling_vercel(tmp_path, monkeypatch):
    monkeypatch.delenv("VERCEL_TOKEN", raising=False)
    http = FakeVercel()
    r = deploy_preview(make_repo(tmp_path), "studio-x", http=http)
    assert (r.status, r.reason) == ("skipped", "no VERCEL_TOKEN")
    assert http.calls == []


def test_token_only_in_the_authorization_header_and_team_id_in_the_query(tmp_path):
    http = FakeVercel(project_exists=True)
    deploy(make_repo(tmp_path), http, team_id="team_9")
    assert not http.find("POST", "/v11/projects")            # existing project reused
    for method, url, headers, body in http.calls:
        assert TOKEN not in url and "teamId=team_9" in url
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert body is None or TOKEN.encode() not in body


def test_node_modules_and_env_files_are_never_uploaded(tmp_path):
    repo = make_repo(tmp_path)
    paths = [p for p, _ in repo_files(repo)]
    assert "src/app/page.tsx" in paths
    assert not [p for p in paths if "node_modules" in p or ".env" in p]
    http = FakeVercel()
    deploy(repo, http)
    assert not [b for b in http.uploaded.values() if b"SECRET" in b or b"module.exports" in b]
    # and even if given explicitly
    assert excluded(".env") and excluded("apps/x/.env.production") and excluded("node_modules/a/b.js")
    assert not excluded("src/env.ts") and not excluded("src/lib/environment.ts")


# ------------------------------------------------------------------ worker
def run_worker_preview(results, deploy_result, merged_before=()):
    from engine.deploy import DeployResult
    from worker import publish_preview
    sink = ListSink()
    calls = []

    def fake(repo, project_name, log, env=None):
        calls.append(project_name)
        return DeployResult(*deploy_result)
    publish_preview(results, Path("/nowhere"), "https://github.com/me/studio-x-abc123", Emitter(sink), deploy=fake,
                    merged_before=merged_before)
    return calls, [(e.kind, e.data) for e in sink.events]


def test_worker_emits_preview_ready_once_integration_merged():
    calls, evs = run_worker_preview([Result("T1", "a", "merged"), Result("INT", "i", "merged")],
                                    ("ready", "https://x.vercel.app", ""))
    assert calls == ["studio-x-abc123"]
    assert evs == [("preview_ready", {"url": "https://x.vercel.app"})]


def test_worker_reports_failed_and_skipped_previews():
    ok = [Result("INT", "i", "merged")]
    assert run_worker_preview(ok, ("failed", "", "boom"))[1] == [("preview_failed", {"reason": "boom"})]
    assert run_worker_preview(ok, ("skipped", "", "no VERCEL_TOKEN"))[1] == [("preview_skipped", {"reason": "no VERCEL_TOKEN"})]


def test_worker_does_not_deploy_without_a_merged_integration():
    calls, evs = run_worker_preview([Result("T1", "a", "merged"), Result("INT", "i", "failed")], ("ready", "u", ""))
    assert calls == [] and evs == []


def test_worker_redeploys_a_retry_when_integration_merged_earlier():
    calls, evs = run_worker_preview([Result("T2", "b", "merged")], ("ready", "https://x.vercel.app", ""),
                                    merged_before={"PLAN", "T1", "INT"})
    assert calls and evs[0][0] == "preview_ready"
    calls, _ = run_worker_preview([Result("T2", "b", "failed")], ("ready", "u", ""), merged_before={"INT"})
    assert calls == []


def test_a_token_scoped_to_one_team_deploys_into_that_team(tmp_path):
    """Regression (first live preview): "You don't have permission to create the project" (403) because the
    token belongs to a team and requests went to the personal scope. The team is found from the token."""
    http = FakeVercel(teams=[{"id": "team_abc", "slug": "briannas-projects"}])
    r = deploy(make_repo(tmp_path), http)
    assert r.status == "ready"
    after = [c[1] for c in http.calls if "/v2/teams" not in c[1]]
    assert after and all("teamId=team_abc" in u for u in after)


def test_several_teams_or_none_leave_the_scope_alone(tmp_path):
    for teams in ([], [{"id": "a"}, {"id": "b"}]):
        http = FakeVercel(teams=teams)
        assert deploy(make_repo(tmp_path / str(len(teams))), http).status == "ready"
        assert not [c for c in http.calls if "teamId=" in c[1]]


# ------------------------------------------------------------------ durable database env
DB_URL = "postgresql://owner:pw-SECRET-1@ep-x-pooler.neon.tech/app_studio_x_abc123?sslmode=require"


def env_posts(http):
    return [json.loads(c[3]) for c in http.find("POST", "/env")]


def test_without_env_nothing_but_telemetry_is_set(tmp_path):
    http = FakeVercel()
    assert deploy(make_repo(tmp_path), http).status == "ready"
    assert env_posts(http) == [[{"key": "NEXT_TELEMETRY_DISABLED", "value": "1", "type": "plain",
                                 "target": ["production", "preview"]}]]
    assert not http.find("GET", "/env")                       # no listing, no session secret


def test_database_url_and_a_new_session_secret_are_set_as_sensitive(tmp_path):
    http = FakeVercel()
    r = deploy(make_repo(tmp_path), http, env={"DATABASE_URL": DB_URL})
    assert r.status == "ready", r.reason
    plain, secret = env_posts(http)
    assert [e["key"] for e in plain] == ["NEXT_TELEMETRY_DISABLED"]
    by_key = {e["key"]: e for e in secret}
    assert set(by_key) == {"DATABASE_URL", "APP_SESSION_SECRET"}
    assert all(e["type"] == "sensitive" and e["target"] == ["production", "preview"] for e in secret)
    assert by_key["DATABASE_URL"]["value"] == DB_URL
    assert len(by_key["APP_SESSION_SECRET"]["value"]) == 64
    assert all("upsert=true" in c[1] for c in http.find("POST", "/env"))
    # env is set before the deployment is created, so the build and the first request see it
    order = [c[1].split("?")[0].rsplit("/", 1)[-1] for c in http.calls if c[0] == "POST"]
    assert order.index("env") < order.index("deployments")


def test_an_existing_session_secret_is_kept(tmp_path):
    http = FakeVercel(project_exists=True, env_keys=["NEXT_TELEMETRY_DISABLED", "APP_SESSION_SECRET", "DATABASE_URL"])
    assert deploy(make_repo(tmp_path), http, env={"DATABASE_URL": DB_URL}).status == "ready"
    assert [e["key"] for e in env_posts(http)[1]] == ["DATABASE_URL"]    # not rotated: sessions survive redeploys


def test_env_failures_fail_the_deploy_without_leaking_values(tmp_path):
    http = FakeVercel(env_failed="DATABASE_URL")
    r = deploy(make_repo(tmp_path), http, env={"DATABASE_URL": DB_URL})
    assert r.status == "failed" and "DATABASE_URL" in r.reason
    assert "pw-SECRET-1" not in r.reason and DB_URL not in r.reason
    assert not http.find("POST", "/v13/deployments")

    def http_err(method, url, headers, body):
        if method == "POST" and "/env" in url and body and b"DATABASE_URL" in body:
            return 400, json.dumps({"error": {"message": f"invalid value {DB_URL}"}}).encode()
        return FakeVercel()(method, url, headers, body)
    r = deploy(make_repo(tmp_path / "b"), http_err, env={"DATABASE_URL": DB_URL})
    assert r.status == "failed" and "pw-SECRET-1" not in r.reason


# ------------------------------------------------------------------ worker: durable database
ADMIN_URL = "postgresql://neondb_owner:ADMIN-PW-9@ep-x.neon.tech/neondb?sslmode=require"


def run_worker_db(monkeypatch, provision, admin=ADMIN_URL):
    from engine.deploy import DeployResult
    from worker import publish_preview
    if admin:
        monkeypatch.setenv("POSTGRES_ADMIN_URL", admin)
    else:
        monkeypatch.delenv("POSTGRES_ADMIN_URL", raising=False)
    sink, deploys, provisions = ListSink(), [], []

    def fake_deploy(repo, project_name, log, **kw):
        deploys.append((project_name, kw))
        return DeployResult("ready", url="https://x.vercel.app")

    def fake_provision(admin_url, slug):
        provisions.append((admin_url, slug))
        return provision(admin_url, slug)
    publish_preview([Result("INT", "i", "merged")], Path("/nowhere"), "https://github.com/me/studio-x-abc123",
                    Emitter(sink), deploy=fake_deploy, provision=fake_provision)
    return provisions, deploys, [(e.kind, e.data) for e in sink.events]


def test_worker_provisions_the_database_and_passes_it_to_the_deploy(monkeypatch):
    url = "postgresql://neondb_owner:ADMIN-PW-9@ep-x.neon.tech/app_studio_x_abc123?sslmode=require"
    provisions, deploys, evs = run_worker_db(monkeypatch, lambda a, s: url)
    assert provisions == [(ADMIN_URL, "studio-x-abc123")]
    assert deploys == [("studio-x-abc123", {"env": {"DATABASE_URL": url}})]
    assert evs == [("database_ready", {"name": "app_studio_x_abc123"}),
                   ("preview_ready", {"url": "https://x.vercel.app"})]
    assert "ADMIN-PW-9" not in json.dumps(evs)


def test_worker_still_deploys_in_local_mode_when_provisioning_fails(monkeypatch):
    def boom(admin_url, slug):
        raise RuntimeError(f"could not connect to {admin_url} (password ADMIN-PW-9)")
    _, deploys, evs = run_worker_db(monkeypatch, boom)
    assert deploys == [("studio-x-abc123", {})]                 # no env: local mode, exactly as before
    assert [k for k, _ in evs] == ["database_failed", "preview_ready"]
    reason = evs[0][1]["reason"]
    assert "could not connect" in reason and "ADMIN-PW-9" not in reason and "neon.tech" not in reason


def test_worker_without_an_admin_url_behaves_as_before(monkeypatch):
    provisions, deploys, evs = run_worker_db(monkeypatch, lambda a, s: "x", admin=None)
    assert provisions == [] and deploys == [("studio-x-abc123", {})]
    assert evs == [("preview_ready", {"url": "https://x.vercel.app"})]
