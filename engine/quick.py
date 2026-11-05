"""Quick changes: small edits to what people see in a built web app (wording, colors, spacing, labels, a missing
link) without the planner, QA or an approval. One dev task, id Q{n}, may edit only the UI (pages, components and
its own unit tests). It is checked by the same whole-app check the integrator's work gets (types, lint, the full
test suite, a production build, every page answers) and merges when that passes.

If the agent finds the request needs more (new data, server logic, a new feature), it ends with
`BLOCKED: needs a change request`: the task stops there, without checks or retries, and `quick_blocked` tells the
app, which offers to send the same words as a change request (docs/change-requests.md).

Events: quick_started {n, text}; Q{n}'s task_queued / task_status / attempt_finished / agent_activity;
quick_blocked {n, reason} when it needs a change request; the worker then emits project_finished.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from engine.engine import Engine, Result
from engine.interfaces import Task
from engine.project import integration_check
from engine.stacks import PythonStack

MAX_ATTEMPTS = 2
# Pages, components and the agent's own tests. Never src/server/, src/lib/, contracts, migrations or plan.json.
QUICK_SCOPE = ["src/app/*", "src/components/*", "tests/unit/*"]
NEEDS_CHANGE = "needs a change request"


class QuickChangeError(ValueError):
    """A quick change can't run for this project (not a web app)."""


QUICK_SPEC = """A quick change to a web app that is already built and working. Make only this change and keep
everything else exactly as it works now.

The user asked for: {request}

Quick changes are small edits to what people see: wording, labels, headings, colors, spacing, layout, or a missing
link or button to a page that already exists. Read AGENTS.md first, then the pages in src/app/ and the components in
src/components/ that the request is about.
- You may only edit files under src/app/, src/components/ and your own tests under tests/unit/. Never edit
  src/server/, src/lib/, src/contracts/, supabase/migrations/, plan.json or any config file.
- If you change what a component in src/components/ shows, update its doc comment to match.
- Some tests in tests/unit/ may check the old wording or look. Update those expectations to the new ones; never
  delete a test of behavior that stays.
- If the request needs anything beyond that (new or different data, a change to what is saved or checked, a new
  page for a new feature, sign-in or accounts, payments, emails), change nothing and end your final message with
  exactly one line:
  BLOCKED: {needs}: <one plain sentence on why>

Pages the app must have: {pages}

Before saying DONE, run all of this and fix anything that fails:
{check}"""

# Requests that are obviously not quick, turned away before any agent runs. Deliberately narrow: wording like
# "make the sign-in button green" must pass. The agent's BLOCKED is the real gate.
TOO_BIG = [
    # "take card payments" is a feature; "make the payment button blue" is a look
    (re.compile(r"\bstripe\b|\b(take|accept|add|charge|collect|enable)\b[^.]*\b(payments?|subscriptions?)\b", re.I),
     "payments"),
    # "a new page" is a feature; "a new page title" is wording
    (re.compile(r"\bnew (page|screen|table|field|column|database|feature|role)s?\b"
                r"(?!\s+(title|heading|header|footer|layout|background|colou?r|name|label)s?\b)", re.I),
     "a new page or new data"),
    (re.compile(r"\b(database|schema|migrations?)\b", re.I), "a data change"),
    (re.compile(r"\b(user accounts|sign[- ]?in system|log[- ]?in system)\b", re.I), "accounts or sign-in"),
]


def too_big(request: str) -> str | None:
    """Why a request is obviously too big for a quick change, or None. A cheap pre-screen before any agent runs."""
    for rx, what in TOO_BIG:
        if rx.search(request):
            return f"{NEEDS_CHANGE}: it asks for {what}"
    return None


def blocked_reason(claim: str) -> str | None:
    """The agent's reason when it says the request needs a change request (`BLOCKED: needs a change request: why`).
    Any other claim, including other BLOCKED reasons, goes through the checks and retries as usual."""
    text = claim.strip()
    if not text.lower().startswith("blocked") or NEEDS_CHANGE not in text.lower():
        return None
    why = text[text.lower().index(NEEDS_CHANGE) + len(NEEDS_CHANGE):].strip(" :-—.()")
    return f"{NEEDS_CHANGE}: {why}" if why else NEEDS_CHANGE


def quick_pages(plan: dict) -> list[str]:
    return [r for r in plan.get("pages", []) if isinstance(r, str)] or ["/"]


def quick_task(n: int, request: str, plan: dict, stack: PythonStack, agent=None) -> Task:
    """Q{n}: one dev task scoped to the UI, verified by the whole-app check (reuses the integrator's)."""
    if not stack.integration:
        raise QuickChangeError("quick changes are only for web apps; ask for a change request instead")
    pages = quick_pages(plan)
    spec = QUICK_SPEC.format(request=request.strip(), needs=NEEDS_CHANGE, pages=", ".join(pages),
                             check=stack.integration_check_cmd(pages))
    return Task(f"Q{n}", f"Quick change {n}", spec, list(QUICK_SCOPE), "", role="dev", agent=agent,
                max_attempts=MAX_ATTEMPTS, check=integration_check(stack, pages), stop_when=blocked_reason)


def quick_project(n: int, request: str, repo: Path, engine: Engine, stack: PythonStack, agent=None) -> list[Result]:
    """Run quick change n in the project's repo. Returns [Q{n}'s result]: merged, failed, or blocked (it needs a
    change request; then quick_blocked was emitted). Nothing else in the repo is rebuilt."""
    emit = engine.events.emit
    plan = json.loads((Path(repo) / "plan.json").read_text())
    task = quick_task(n, request, plan, stack, agent)        # raises for stacks without quick changes
    emit("quick_started", n=n, text=request)
    if why := too_big(request):
        emit("quick_blocked", n=n, reason=why)
        return [Result(task.id, task.title, status="blocked", error=why)]
    results = engine.run_all([task], parallel=1)
    r = results[0]
    if r.status == "blocked":
        emit("quick_blocked", n=n, reason=r.error)
    return results


def quick_blocked(results: list[Result]) -> bool:
    """Whether a quick change stopped because it needs a change request (the worker reports it as "blocked")."""
    return bool(results) and results[0].task.startswith("Q") and results[0].status == "blocked"
