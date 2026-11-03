"""Writes engine events into Supabase (tables in supabase/migrations) so the web app updates live.

Uses the PostgREST API with the service-role key, standard library only. The key comes from the
environment and is never logged."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from typing import Callable

from engine.events import Event

Post = Callable[[str, str, dict, object], None]          # (method, path, headers, body)


def _http(base: str, key: str) -> Post:
    def send(method: str, path: str, headers: dict, body) -> None:
        req = urllib.request.Request(f"{base}/rest/v1/{path}", method=method,
                                     data=json.dumps(body).encode(),
                                     headers={"apikey": key, "Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json", **headers})
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    return send


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


class SupabaseSink:
    def __init__(self, project_id: str, url: str | None = None, key: str | None = None, post: Post | None = None):
        self.project_id = project_id
        self.post = post or _http((url or os.environ["SUPABASE_URL"]).rstrip("/"),
                                  key or os.environ["SUPABASE_SERVICE_ROLE_KEY"])
        self.task_cost: dict[str, float] = {}

    def _upsert(self, table: str, row: dict) -> None:
        self.post("POST", table, {"Prefer": "resolution=merge-duplicates,return=minimal"}, row)

    def _project(self, **fields) -> None:
        self.post("PATCH", f"projects?id=eq.{self.project_id}", {"Prefer": "return=minimal"},
                  {**fields, "updated_at": iso(time.time())})

    def write(self, e: Event) -> None:
        pid, d = self.project_id, e.data
        self.post("POST", "events", {"Prefer": "return=minimal"},
                  {"project_id": pid, "kind": e.kind, "task_id": e.task_id,
                   "data": json.loads(json.dumps(d, default=str)), "ts": iso(e.ts)})
        if e.kind == "task_queued":
            self._upsert("tasks", {"project_id": pid, "id": e.task_id, "title": d["title"], "role": d["role"],
                                   "depends_on": d["depends_on"], "status": "queued", "updated_at": iso(e.ts)})
            if e.task_id == "PLAN":
                self._project(status="planning")
        elif e.kind == "task_status":
            row = {"project_id": pid, "id": e.task_id, "status": d["status"], "updated_at": iso(e.ts)}
            if "attempt" in d:
                row["attempt"] = d["attempt"]
            if d.get("error"):
                row["error"] = d["error"]
            self.post("PATCH", f"tasks?project_id=eq.{pid}&id=eq.{e.task_id}", {"Prefer": "return=minimal"},
                      {k: v for k, v in row.items() if k not in ("project_id", "id")})
        elif e.kind == "attempt_finished":
            self._upsert("attempts", {"project_id": pid, "task_id": e.task_id, "n": d["n"], "passed": d["passed"],
                                      "claim": d["claim"], "reason": d["reason"], "cost_usd": d["cost_usd"],
                                      "seconds": d["seconds"], "turns": d["turns"],
                                      "files_changed": d["files_changed"]})
            self.task_cost[e.task_id] = self.task_cost.get(e.task_id, 0) + d["cost_usd"]
            self.post("PATCH", f"tasks?project_id=eq.{pid}&id=eq.{e.task_id}", {"Prefer": "return=minimal"},
                      {"cost_usd": round(self.task_cost[e.task_id], 4)})
            self._project(cost_usd=round(sum(self.task_cost.values()), 4))
        elif e.kind == "plan_ready":
            self._project(status="awaiting_approval", plan=d["plan"])
        elif e.kind == "plan_decision":
            self._project(status="building" if d["approved"] else "rejected")
        elif e.kind == "project_finished":
            self._project(status=d["status"])
