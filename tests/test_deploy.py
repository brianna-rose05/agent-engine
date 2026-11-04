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

    def __init__(self, states=("BUILDING", "READY"), project_exists=False, error_message="Command failed: next build"):
        self.calls = []
        self.states = list(states)
        self.project_exists = project_exists
        self.error_message = error_message
        self.uploaded = {}

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        path = url.split("https://api.vercel.com", 1)[1].split("?")[0]
        if method == "GET" and path.startswith("/v9/projects/"):
            return (200, b'{"id":"prj_1"}') if self.project_exists else (404, b'{"error":{"code":"not_found"}}')
        if method == "POST" and path == "/v11/projects":
            return 200, b'{"id":"prj_1"}'
        if method == "POST" and path.endswith("/env"):
            return 201, b'{"created":[],"failed":[]}'
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

    def fake(repo, project_name, log):
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
