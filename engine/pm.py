"""The PM role, first slice (docs/pm.md): story priorities in the plan, features saved for later, the ship gate,
and retro notes. Everything here is deterministic: the PM makes no model call.

    priority        every plan task is "must", "should" or "could" (missing: "must", so older plans still work).
    saved for later the owner can leave should/could features out of a build to fit the budget; they aren't built.
    ready_to_ship   once every Must feature is merged and the app is integrated, the app may ship.
    retro           after every build, retry and change, a short note of what failed and why is appended to
                    docs/retro.md in the project's repo; the change planner and the tech lead read its end.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from engine.engine import git
from engine.gitlock import repo_lock

PRIORITIES = ("must", "should", "could")         # highest first
OK = ("merged", "passed")
RETRO_PATH = "docs/retro.md"
RETRO_READ_CHARS = 2000                          # how much of the end of docs/retro.md planners and tech leads see
SUMMARY_MAX = 600
RETRO_HEADER = ("# Retro notes\n\nWritten by the PM after every build, retry and change: what merged, what failed and "
                "why, what took more than one try, and what was saved for later. The tech lead and the change planner "
                "read the end of this file before they plan.\n")


# ---------------------------------------------------------------- priorities
def priority(t: dict) -> str:
    """A plan task's priority; plans without one (older plans, the benchmark) are all "must"."""
    return t.get("priority") if t.get("priority") in PRIORITIES else "must"


def priority_problems(tasks: list) -> list[str]:
    """A task may not depend on a task of lower priority: saving the lower one for later would strand it."""
    by_id = {t["id"]: t for t in tasks if isinstance(t, dict) and isinstance(t.get("id"), str)}
    p = []
    for t in by_id.values():
        for d in t.get("depends_on", []) or []:
            if d in by_id and PRIORITIES.index(priority(by_id[d])) > PRIORITIES.index(priority(t)):
                p.append(f'{t["id"]} ("{priority(t)}") depends on {d} ("{priority(by_id[d])}"): a task may only '
                         f'depend on tasks of the same or a higher priority; give {d} priority "{priority(t)}" or '
                         "drop the dependency")
    return p


def saved_ids(plan: dict, deferred) -> list[str]:
    """The tasks saved for later, in plan order: the owner's choice (never a "must" task, never an id the plan
    doesn't have) plus every should/could task that depends on one of them (it could only end blocked)."""
    tasks = [t for t in plan.get("tasks", []) if isinstance(t, dict)]
    chosen = {str(d) for d in (deferred or ())}
    saved = {t["id"] for t in tasks if t["id"] in chosen and priority(t) != "must"}
    grew = True
    while grew:
        grew = False
        for t in tasks:
            if t["id"] not in saved and priority(t) != "must" and set(t.get("depends_on", [])) & saved:
                saved.add(t["id"])
                grew = True
    return [t["id"] for t in tasks if t["id"] in saved]


def saved_note(tasks: list[dict]) -> str:
    """The integrator's note about features saved for later ("" when there are none)."""
    if not tasks:
        return ""
    lines = "\n".join(f"- {t['module']}: {t['title']}" for t in tasks)
    return ("\nSaved for later (the owner left these features out of this version, so they are not built):\n"
            f"{lines}\nTheir modules are still unimplemented stubs: never import or call them, and don't link to "
            "their screens. If a page below exists only for one of them, keep it as a simple page that says the "
            "feature is coming soon.\n")


# ---------------------------------------------------------------- ship gate
def ship_ready(plan: dict | None, results, merged_before=(), needs_int: bool = True) -> dict | None:
    """ready_to_ship's data, {saved, musts}, when every Must task is merged (in this run or before) and the
    integration merged (when the stack has one); else None. A Must that failed in this run (a change's task, whose
    id isn't in plan.json, counts as a Must: the owner asked for it) means not ready. `saved` lists the should/could
    tasks that aren't merged (saved for later or failed): they never block shipping."""
    if not isinstance(plan, dict) or not isinstance(plan.get("tasks"), list):
        return None
    tasks = [t for t in plan["tasks"] if isinstance(t, dict) and "id" in t]
    pri = {t["id"]: priority(t) for t in tasks}
    merged = set(merged_before) | {r.task for r in results if r.status == "merged"}
    for r in results:
        if r.status not in OK and r.task != "INT" and not r.task.endswith("-qa") and pri.get(r.task, "must") == "must":
            return None
    musts = [t["id"] for t in tasks if pri[t["id"]] == "must"]
    if any(m not in merged for m in musts) or (needs_int and "INT" not in merged):
        return None
    return {"saved": [t["id"] for t in tasks if pri[t["id"]] != "must" and t["id"] not in merged], "musts": len(musts)}


# ---------------------------------------------------------------- retro
def read_retro(repo: Path, limit: int = RETRO_READ_CHARS) -> str:
    """The end of docs/retro.md (whole lines, at most `limit` characters), or "" when there is none."""
    try:
        text = (Path(repo) / RETRO_PATH).read_text()
    except (OSError, UnicodeDecodeError):
        return ""
    text = text.strip()
    if len(text) > limit:
        text = text[-limit:]
        text = text[text.index("\n") + 1:] if "\n" in text else text
    return text.strip()


def retro_block(retro: str) -> str:
    """The retro notes as a block of a planner's or tech lead's instructions ("" when there are none)."""
    if not (retro or "").strip():
        return ""
    return f"\nNotes from earlier runs (retro), the end of {RETRO_PATH}:\n{retro.strip()}\n"


def _one_line(text: str, limit: int = 300) -> str:
    one = " ".join(str(text or "").split())
    return one if len(one) <= limit else one[:limit - 1] + "…"


def _is_feature(task_id: str) -> bool:
    return not task_id.endswith("-qa") and not task_id.endswith("PLAN")


def retro_section(label: str, results, plan: dict | None = None, deferred=(), cost_usd: float | None = None,
                  when: datetime | None = None) -> tuple[str, str]:
    """(markdown section for docs/retro.md, plain-English summary of at most 600 characters) for one run."""
    when = when or datetime.now(timezone.utc)
    titles = {t["id"]: t.get("title", t["id"]) for t in (plan or {}).get("tasks", []) if isinstance(t, dict)}
    for r in results:
        titles.setdefault(r.task, r.title or r.task)
    name = lambda tid: titles.get(tid, tid)                                       # noqa: E731
    features = [r for r in results if _is_feature(r.task)]
    merged = [r for r in features if r.status == "merged"]
    failed = [r for r in results if r.status not in OK]
    retried = [r for r in results if len(r.attempts) > 1]
    saved = [name(d) for d in deferred or ()]
    cost = sum(r.cost_usd for r in results) if cost_usd is None else cost_usd

    def why(r) -> str:
        last = r.attempts[-1].reason if r.attempts else ""
        parts = [p for p in (last, r.error) if p]
        if len(parts) == 2 and parts[0] in parts[1]:
            parts = parts[1:]
        return _one_line(". ".join(parts) or r.status)

    lines = [f"## {when:%Y-%m-%d %H:%M} UTC · {_one_line(label, 120)}", "",
             f"- Merged: {len(merged)} of {len(features)} tasks"]
    if failed:
        lines.append("- Didn't finish:")
        lines += [f"  - {name(r.task)} ({r.task}): {r.status}. {why(r)}" for r in failed]
    if retried:
        lines.append("- Took more than one try:")
        for r in retried:
            reasons = "; ".join(_one_line(a.reason, 160) for a in r.attempts if a.reason) or "no reason recorded"
            lines.append(f"  - {name(r.task)} ({r.task}): {len(r.attempts)} tries. {reasons}")
    if saved:
        lines.append(f"- Saved for later: {', '.join(saved)}")
    lines.append(f"- Cost of this run: ${cost:.2f}")

    summary = f"{_one_line(label, 80)}: {len(merged)} of {len(features)} tasks merged."
    if failed:
        summary += " Didn't finish: " + "; ".join(f"{name(r.task)} ({_one_line(why(r), 90)})" for r in failed[:4])
        summary += f" and {len(failed) - 4} more." if len(failed) > 4 else "."
    if retried:
        summary += f" {len(retried)} task{'s' if len(retried) > 1 else ''} took more than one try."
    if saved:
        summary += f" Saved for later: {', '.join(saved)}."
    summary += f" Cost ${cost:.2f}."
    if len(summary) > SUMMARY_MAX:
        summary = summary[:SUMMARY_MAX - 1] + "…"
    return "\n".join(lines) + "\n", summary


def write_retro(repo: Path, label: str, results, events, plan: dict | None = None, deferred=(),
                cost_usd: float | None = None, when: datetime | None = None) -> str | None:
    """Append this run's section to docs/retro.md on main, commit "Retro: <label>" and push it, then emit
    retro_written {summary}. Returns the summary, or None if it couldn't be saved. Never raises, and never leaves
    the clone ahead of its remote: a retro that can't be saved must not fail a run."""
    repo = Path(repo)
    try:
        section, summary = retro_section(label, results, plan, deferred, cost_usd, when)
        with repo_lock(repo):
            path = repo / RETRO_PATH
            before = path.read_text() if path.exists() else None
            old = git(["rev-parse", "--verify", "HEAD"], repo).stdout.strip()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text((before if before is not None else RETRO_HEADER).rstrip("\n") + "\n\n" + section)
            ok = (git(["add", "--", RETRO_PATH], repo).returncode == 0
                  and git(["commit", "-qm", f"Retro: {_one_line(label, 120)}", "--", RETRO_PATH], repo).returncode == 0)
            if ok and git(["remote"], repo).stdout.strip():
                pushed = git(["push", "-q", "origin", "main"], repo)
                if pushed.returncode:
                    print(f"retro: not pushed ({pushed.stderr.strip()[:200]})")
                    git(["reset", "-q", "--keep", old], repo)
                    return None
            if not ok:
                git(["reset", "-q", "--", RETRO_PATH], repo)
                if before is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(before)
                print("retro: not committed")
                return None
    except Exception as e:
        print(f"retro: not saved ({type(e).__name__}: {e})"[:300])
        return None
    events.emit("retro_written", summary=summary)
    return summary
