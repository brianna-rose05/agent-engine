"""The Supabase sink maps engine events onto the tables the web app reads. No network: fake HTTP."""
from engine.events import Event
from engine.supabase_sink import SupabaseSink


def sink():
    calls = []
    return SupabaseSink("p1", post=lambda m, path, h, body: calls.append((m, path, body))), calls


def test_queued_task_creates_row_and_planning_status():
    s, calls = sink()
    s.write(Event("task_queued", "PLAN", {"title": "Plan", "role": "planner", "depends_on": []}))
    assert calls[0][1] == "events"
    assert calls[1][:2] == ("POST", "tasks") and calls[1][2]["status"] == "queued"
    assert calls[2][:2] == ("PATCH", "projects?id=eq.p1") and calls[2][2]["status"] == "planning"


def test_attempt_costs_roll_up_to_task_and_project():
    s, calls = sink()
    for tid, cost in (("T1", 0.01), ("T1", 0.02), ("T2", 0.5)):
        s.write(Event("attempt_finished", tid, {"n": 1, "passed": False, "claim": "done", "reason": "x",
                                                "cost_usd": cost, "seconds": 1.0, "turns": 3, "files_changed": []}))
    project_costs = [b["cost_usd"] for m, p, b in calls if p.startswith("projects")]
    assert project_costs[-1] == 0.53
    task_costs = [b["cost_usd"] for m, p, b in calls if p.startswith("tasks?") and "id=eq.T1" in p]
    assert task_costs == [0.01, 0.03]


def test_plan_ready_waits_for_approval_and_decision_moves_on():
    s, calls = sink()
    s.write(Event("plan_ready", None, {"plan": {"project": "x"}}))
    s.write(Event("plan_decision", None, {"approved": False, "note": ""}))
    statuses = [b["status"] for m, p, b in calls if p.startswith("projects")]
    assert statuses == ["awaiting_approval", "rejected"]


def test_status_updates_patch_only_that_task():
    s, calls = sink()
    s.write(Event("task_status", "T2", {"status": "blocked", "error": "waiting on T1"}))
    m, path, body = calls[1]
    assert (m, path) == ("PATCH", "tasks?project_id=eq.p1&id=eq.T2")
    assert body["status"] == "blocked" and body["error"] == "waiting on T1"


def test_worker_waits_for_the_users_decision():
    from worker import wait_for_decision
    rows = iter([{"status": "awaiting_approval"}, {"status": "awaiting_approval"},
                 {"status": "approved", "plan_note": "looks good"}])
    naps = []
    approve = wait_for_decision(lambda: next(rows), poll_s=5, sleep=naps.append)
    assert approve({}) == (True, "looks good") and naps == [5, 5]


def test_worker_gives_up_without_a_decision():
    from worker import wait_for_decision
    approve = wait_for_decision(lambda: {"status": "awaiting_approval"}, poll_s=60, timeout_s=120, sleep=lambda s: None)
    approved, note = approve({})
    assert not approved and "2 minutes" in note
