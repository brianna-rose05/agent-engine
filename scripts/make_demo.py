"""Turn a real project run (results.json + plan.json) into the web app's demo replay.

Re-simulates the engine's scheduler (dependencies, 4 in parallel) with each attempt's real
duration and cost, emitting the same event kinds the engine streams live. Nothing is invented:
titles, specs, durations, costs and outcomes all come from the run."""
import json
import sys
from pathlib import Path

run = Path(sys.argv[1])
out = Path(sys.argv[2])
results = {r["task"]: r for r in json.loads((run / "results.json").read_text())}
plan = json.loads((run / "plan.json").read_text())
description = Path(sys.argv[3]).read_text() if len(sys.argv) > 3 else ""

deps = {"PLAN": []}
for t in plan["tasks"]:
    deps[f"{t['id']}-qa"] = ["PLAN"]
    deps[t["id"]] = ["PLAN", *t.get("depends_on", []), f"{t['id']}-qa"]
order = ["PLAN"] + [x for t in plan["tasks"] for x in (f"{t['id']}-qa", t["id"])]
role = lambda tid: "planner" if tid == "PLAN" else ("qa" if tid.endswith("-qa") else "dev")
public = lambda tid: [d for d in deps[tid] if d != "PLAN"]

events, t = [], 0.0
APPROVAL_PAUSE = 6.0          # demo stand-in for the moment the user reads and approves the plan


def emit(ts, kind, task=None, **data):
    events.append({"t": round(ts, 1), "kind": kind, "task_id": task, "data": data})


def run_task(tid, start):
    """Events for one task's attempts; returns its finish time."""
    ts = start
    for a in results[tid]["attempts"]:
        work, check = a["seconds"] * 0.8, a["seconds"] * 0.2
        emit(ts, "task_status", tid, status="working", attempt=a["n"])
        emit(ts + work, "task_status", tid, status="checking", attempt=a["n"])
        ts += work + check
        emit(ts, "attempt_finished", tid, n=a["n"], passed=a["passed"], claim=a["claim"], reason=a["reason"],
             cost_usd=a["cost_usd"], seconds=a["seconds"], turns=a["turns"], files_changed=a["files_changed"])
    emit(ts, "task_status", tid, status=results[tid]["status"], cost_usd=results[tid]["cost_usd"])
    return ts


emit(0, "task_queued", "PLAN", title=results["PLAN"]["title"], role="planner", depends_on=[])
plan_end = run_task("PLAN", 0.0)
emit(plan_end, "plan_ready", plan=plan)
start_build = plan_end + APPROVAL_PAUSE
emit(start_build, "plan_decision", approved=True, note="")
for tid in order[1:]:
    emit(start_build, "task_queued", tid, title=results[tid]["title"], role=role(tid), depends_on=public(tid))

# Same policy as Engine.run_all: start anything whose dependencies are done, 4 at a time, input order.
finished, running, slots = {"PLAN": plan_end}, {}, 4
pending = order[1:]
now = start_build
while pending or running:
    for tid in list(pending):
        if len(running) < slots and all(d in finished for d in deps[tid]):
            running[tid] = run_task(tid, max(now, max(finished[d] for d in deps[tid])))
            pending.remove(tid)
    if not running:
        break
    tid = min(running, key=running.get)
    now = finished[tid] = running.pop(tid)
total = sum(r["cost_usd"] for r in results.values())
emit(now, "project_finished", status="done", cost_usd=round(total, 4))
events.sort(key=lambda e: e["t"])

demo = {"project": {"id": "demo", "name": "Community garden", "description": description, "model": "haiku",
                    "status": "queued", "created_at": "2026-11-03T00:44:15Z"},
        "plan": plan, "events": events,
        "source": f"Replay of a real Haiku run ({run.parent.name}); durations and costs as measured."}
out.write_text(json.dumps(demo, indent=1))
print(f"{len(events)} events, {now:.0f}s, ${total:.4f}")
