"""A live preview of a finished project: its main branch deployed to Vercel through the REST API.

    result = deploy_preview(repo_dir, project_name="studio-garden-ab12cd")
    result.status   # "ready" (result.url) | "failed" (result.reason) | "skipped" (result.reason)

The repo's committed files (`git ls-tree` of main, never node_modules or any .env file) are uploaded
to /v2/files by sha1, then one production deployment of a per-project Vercel project is created with
`framework: nextjs` and polled until READY or ERROR. The app runs in local mode (no DATABASE_URL), so the
preview needs no database; its data lives in memory and resets.

The token is only ever sent in the Authorization header: never in a URL, an error message or an event.
The HTTP layer is injectable (`http=`) so tests run against a fake.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

API = "https://api.vercel.com"
TIMEOUT_S = 10 * 60
POLL_S = 5.0
ENV = {"NEXT_TELEMETRY_DISABLED": "1"}          # never DATABASE_URL: previews run in local mode
SKIP_DIRS = {"node_modules", ".next", ".vercel", ".git"}
MAX_FILE_BYTES = 50 * 1024 * 1024


@dataclass
class DeployResult:
    status: str             # ready | failed | skipped
    url: str = ""
    reason: str = ""


class Http(Protocol):
    def __call__(self, method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]: ...


def urllib_http(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class DeployError(Exception):
    pass


def excluded(path: str) -> bool:
    """Never uploaded: installed packages, build output, local settings and every .env file."""
    parts = path.split("/")
    return any(p in SKIP_DIRS for p in parts) or parts[-1].startswith(".env")


def repo_files(repo: Path, ref: str = "main") -> list[tuple[str, bytes]]:
    """(path, content) for each committed regular file on `ref`, minus the excluded ones."""
    out = subprocess.run(["git", "ls-tree", "-r", "-z", ref], cwd=repo, capture_output=True, check=True).stdout
    files = []
    for entry in out.decode().split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        mode, kind, sha = meta.split()
        if kind != "blob" or mode == "120000" or excluded(path):     # skip submodules and symlinks
            continue
        data = subprocess.run(["git", "cat-file", "blob", sha], cwd=repo, capture_output=True, check=True).stdout
        files.append((path, data))
    return files


def project_slug(name: str) -> str:
    """Vercel project names: lowercase letters, digits, '.', '_', '-'; at most 100 characters."""
    return re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-._")[:100] or "studio-preview"


class Vercel:
    def __init__(self, token: str, team_id: str | None = None, http: Http = urllib_http):
        self.token = token
        self.team_id = team_id
        self.http = http

    def url(self, path: str, **query) -> str:
        if self.team_id:
            query["teamId"] = self.team_id
        q = {k: v for k, v in query.items() if v is not None}
        return f"{API}{path}" + (f"?{urllib.parse.urlencode(q)}" if q else "")

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, headers: dict | None = None,
             ok=(200, 201), **query) -> tuple[int, dict]:
        h = {"Authorization": f"Bearer {self.token}", "User-Agent": "studio-engine", **(headers or {})}
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        status, resp = self.http(method, self.url(path, **query), h, data)
        try:
            parsed = json.loads(resp or b"{}")
        except ValueError:
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {"value": parsed}
        if status not in ok:
            err = parsed.get("error") if isinstance(parsed.get("error"), dict) else {}
            msg = err.get("message") or parsed.get("message") or f"HTTP {status}"
            raise DeployError(self.scrub(f"Vercel {method} {path.split('?')[0]} failed ({status}): {msg}")[:300])
        return status, parsed

    def find_team(self) -> str | None:
        """The token's team when it belongs to exactly one. Regression (first live preview): Vercel puts Hobby
        accounts under a team and a token scoped to it can't create projects outside it ("You don't have
        permission to create the project"), so without a team id every deploy failed."""
        try:
            _, d = self.call("GET", "/v2/teams", limit="20")
        except DeployError:
            return None
        teams = [t for t in d.get("teams") or [] if isinstance(t, dict) and t.get("id")]
        return teams[0]["id"] if len(teams) == 1 else None

    def scrub(self, text: str) -> str:
        return text.replace(self.token, "***") if self.token else text

    # ---------------------------------------------------------------- steps
    def ensure_project(self, name: str) -> None:
        status, _ = self.call("GET", f"/v9/projects/{urllib.parse.quote(name)}", ok=(200, 404))
        if status == 404:
            self.call("POST", "/v11/projects", {"name": name, "framework": "nextjs"})
        targets = ["production", "preview"]
        self.call("POST", f"/v10/projects/{urllib.parse.quote(name)}/env",
                  [{"key": k, "value": v, "type": "plain", "target": targets} for k, v in ENV.items()], upsert="true")

    def upload(self, data: bytes) -> str:
        sha = hashlib.sha1(data).hexdigest()
        self.call("POST", "/v2/files", raw=data,
                  headers={"Content-Type": "application/octet-stream", "Content-Length": str(len(data)),
                           "x-vercel-digest": sha})
        return sha

    def create_deployment(self, name: str, files: list[dict]) -> dict:
        _, d = self.call("POST", "/v13/deployments",
                         {"name": name, "project": name, "target": "production", "files": files,
                          "projectSettings": {"framework": "nextjs"}},
                         skipAutoDetectionConfirmation="1")
        return d

    def deployment(self, dep_id: str) -> dict:
        return self.call("GET", f"/v13/deployments/{urllib.parse.quote(dep_id)}")[1]


def public_url(d: dict, name: str) -> str:
    """The stable production alias (<project>.vercel.app) when assigned: public under Vercel's standard
    deployment protection, unlike the per-deployment URL. Falls back to the deployment's own URL."""
    aliases = [a for a in d.get("alias") or [] if isinstance(a, str)]
    host = next((a for a in aliases if a == f"{name}.vercel.app"), None) or (aliases[0] if aliases else d.get("url", ""))
    if not host:
        return ""
    return host if host.startswith("http") else f"https://{host}"


def deploy_preview(repo: Path, project_name: str, token: str | None = None, team_id: str | None = None,
                   http: Http = urllib_http, files: list[tuple[str, bytes]] | None = None,
                   timeout_s: float = TIMEOUT_S, poll_s: float = POLL_S,
                   sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                   log: Callable[[str], None] = lambda _m: None) -> DeployResult:
    """Deploy `repo`'s main branch. Never raises: every problem comes back as a failed result."""
    token = token if token is not None else os.environ.get("VERCEL_TOKEN", "")
    team_id = team_id if team_id is not None else (os.environ.get("VERCEL_TEAM_ID") or None)
    if not token:
        return DeployResult("skipped", reason="no VERCEL_TOKEN")
    v = Vercel(token, team_id, http)
    if not team_id:
        v.team_id = v.find_team()
    name = project_slug(project_name)
    try:
        files = [(p, d) for p, d in (files if files is not None else repo_files(Path(repo))) if not excluded(p)]
        if not files:
            return DeployResult("failed", reason="nothing to deploy: main has no files")
        big = [p for p, d in files if len(d) > MAX_FILE_BYTES]
        if big:
            return DeployResult("failed", reason=f"file too large to deploy: {big[0]}")
        v.ensure_project(name)
        log(f"uploading {len(files)} files to Vercel project {name}")
        manifest = [{"file": p, "sha": v.upload(d), "size": len(d)} for p, d in files]
        d = v.create_deployment(name, manifest)
        dep_id = d.get("id")
        if not dep_id:
            return DeployResult("failed", reason="Vercel did not return a deployment id")
        start = clock()
        while True:
            state = d.get("readyState") or d.get("status")
            if state == "READY":
                url = public_url(d, name)
                return DeployResult("ready", url=url) if url else DeployResult("failed", reason="deployed, but no URL")
            if state in ("ERROR", "CANCELED"):
                msg = d.get("errorMessage") or d.get("errorCode") or "the build failed"
                return DeployResult("failed", reason=v.scrub(f"Vercel build {state.lower()}: {msg}")[:300])
            if clock() - start >= timeout_s:
                return DeployResult("failed", reason=f"not ready after {int(timeout_s // 60)} minutes (last state {state})")
            sleep(poll_s)
            d = v.deployment(dep_id)
    except DeployError as e:
        return DeployResult("failed", reason=str(e))
    except Exception as e:                      # a preview must never take down a finished build
        return DeployResult("failed", reason=v.scrub(f"{type(e).__name__}: {e}")[:300])
