"""Live progress for the UI. The engine emits an event at every step; a sink stores or forwards it.

Event kinds and their data:
    task_queued      {title, role, depends_on}
    task_status      {status}   working | checking | merging | merged | passed | failed | blocked | error | stopped
                                waiting_for_sandbox {error}: the provider is at capacity; waiting to retry
                                sandbox_lost {attempt, retry, error}: the sandbox dropped mid-attempt;
                                    the attempt is redone in a fresh one (not one of the agent's tries)
                                reviewing {attempt}: the tech lead is reviewing a feature whose tries all failed
                                reviewing_code {attempt}: the code reviewer is reading a passing attempt before it
                                    merges (docs/reviewer.md); its attempt_finished follows the verdict
                                architect_reviewing {attempt}: the architect is reviewing a plan (PLAN, C{n}PLAN) that
                                    passed its checks, before it merges (docs/architect.md)
    attempt_finished {n, passed, claim, reason, cost_usd, seconds, turns, files_changed}
    code_review      {verdict, comments, attempt, note?, review_error?, skipped?}   (docs/reviewer.md)
                     verdict changes: that attempt failed ("the reviewer requested changes") and the dev tries again;
                     approve: it merges (also when the review broke, review_error, or the limit kept it from running,
                     skipped)
    tech_lead_review {decision, note, stronger_model, question?, model?, tech_lead_error?}   (docs/tech-lead.md)
                     decision retry: more attempts follow (n = 4, 5), on `model` when it switched the dev agent
    architect_review {verdict, comments, round, warnings?, architect_error?, skipped?}   (docs/architect.md)
                     task id: the planner's. Round 1 changes: that plan attempt failed ("the architect requested
                     changes") and the planner tries once more with the comments. Round 2 changes carries warnings: the
                     plan merges and goes to the owner with the comments. Approve: it merges (also when the review
                     broke, architect_error, or the limit kept it from running, skipped)
    escalated        {question}   the task ends failed after a review; its error is "Needs you: <question>"
    plan_ready       {plan}
    plan_decision    {approved, note}
    preview_ready    {url}      the finished app on Vercel (worker.py, engine/deploy.py)
    preview_failed   {reason}
    preview_skipped  {reason}   e.g. no VERCEL_TOKEN
    database_ready   {name}     the preview's own Postgres exists (worker.py, engine/databases.py); never a URL
    database_failed  {reason}   (scrubbed) the preview deploys in local mode instead (docs/databases.md)
    budget_reached   {spent, budget}   the project's spending limit stopped new work (once per run, engine/budget.py);
                     tasks that never started end with task_status "stopped", the run with project_finished "stopped"
    agent_activity   {attempt, note, notes}   what a running agent is doing ("Wrote src/x.ts"),
                     at most one every ~10 s per task; note is the latest of notes
    checkpoint_created {n, tag, sha, label, merged}   a save point (engine/checkpoints.py, docs/checkpoints.md)
    rollback_started {n} / rollback_done {to, n, sha} / rollback_failed {n, reason}
    ship_started     {version, rollback}   version: the target of a production rollback, null for a new ship
    ship_check       {name, label, status, detail?}   running | passed | failed (detail: end of the output, scrubbed)
    ship_live        {url, version, tag, sha, rollback, database}   production is on version `tag` (docs/ship.md)
    ship_failed      {reason, check?}   plain English, scrubbed; nothing new is live
    pm_deferred      {tasks, titles}   features saved for later at the start of a build or retry (docs/pm.md)
    ready_to_ship    {saved, musts}    every Must feature merged and the app integrated; after project_finished
    retro_written    {summary}         the run's notes were appended to docs/retro.md and pushed (≤600 chars)
A sink must never break a run: errors inside a sink are swallowed by `emit`.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class Event:
    kind: str
    task_id: str | None = None
    data: dict = field(default_factory=dict)
    ts: float = field(default_factory=time.time)


class EventSink(Protocol):
    def write(self, event: Event) -> None: ...


class ListSink:
    """Keeps events in memory (tests, and the offline demo export)."""

    def __init__(self):
        self.events: list[Event] = []
        self._lock = threading.Lock()

    def write(self, event: Event) -> None:
        with self._lock:
            self.events.append(event)


class JsonlSink:
    """One JSON object per line. The web app's offline mode reads this file."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, event: Event) -> None:
        line = json.dumps(asdict(event), default=str)
        with self._lock, self.path.open("a") as f:
            f.write(line + "\n")


class Emitter:
    def __init__(self, *sinks: EventSink):
        self.sinks = [s for s in sinks if s is not None]

    def emit(self, kind: str, task_id: str | None = None, **data) -> None:
        ev = Event(kind, task_id, data)
        for s in self.sinks:
            try:
                s.write(ev)
            except Exception:       # progress reporting must never take down a build
                pass
