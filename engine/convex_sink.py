"""Streams engine events into the app's Convex backend (web/convex/engine.ts), standard library only.

The worker authenticates with ENGINE_SECRET, derived from the Convex deploy key (CONVEX_DEPLOY_KEY), so
no extra secret has to be created. Keys and secrets are never logged."""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from typing import Callable

from engine.events import Event

Call = Callable[[str, str, dict], object]          # (kind: "query" | "mutation", path, args) -> value


def engine_secret(deploy_key: str) -> str:
    """Shared by worker.py and the Convex deploy workflow (.github/workflows/convex.yml)."""
    return hashlib.sha256(f"studio-engine:{deploy_key}".encode()).hexdigest()


def deployment_url(deploy_key: str) -> str:
    """'prod:posh-peccary-112|...' -> https://posh-peccary-112.convex.cloud"""
    name = deploy_key.split("|", 1)[0].split(":", 1)[-1]
    if not name or not all(c.isalnum() or c == "-" for c in name):
        raise ValueError("CONVEX_DEPLOY_KEY doesn't look like a deploy key")
    return f"https://{name}.convex.cloud"


def http_call(url: str) -> Call:
    def call(kind: str, path: str, args: dict):
        req = urllib.request.Request(f"{url}/api/{kind}", method="POST",
                                     data=json.dumps({"path": path, "args": args, "format": "json"}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
        if body.get("status") != "success":
            raise RuntimeError(f"Convex {path} failed: {body.get('errorMessage', body)}"[:300])
        return body.get("value")
    return call


class ConvexBackend:
    def __init__(self, project_id: str, deploy_key: str | None = None, call: Call | None = None):
        key = deploy_key or os.environ.get("CONVEX_DEPLOY_KEY", "")
        self.project_id = project_id
        self.secret = engine_secret(key) if key else ""
        self.call = call or http_call(os.environ.get("CONVEX_URL") or deployment_url(key))

    def project(self) -> dict | None:
        return self.call("query", "engine:projectForWorker", {"secret": self.secret, "projectId": self.project_id})

    def write(self, e: Event) -> None:
        """An EventSink: one engine event -> one Convex mutation."""
        self.call("mutation", "engine:record", {
            "secret": self.secret, "projectId": self.project_id, "kind": e.kind, "taskId": e.task_id,
            "data": json.loads(json.dumps(e.data, default=str)), "ts": e.ts})
