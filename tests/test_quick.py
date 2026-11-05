"""Quick changes (engine/quick.py): one UI-only task, checked by the whole-app check, merged without approval."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from engine.agents.scripted import ScriptedTeam
from engine.engine import Engine
from engine.events import Emitter, ListSink
from engine.interfaces import AgentReport
from engine.project import build_project_repo, default_stack, run_project
from engine.quick import QUICK_SCOPE, QuickChangeError, blocked_reason, quick_blocked, quick_project, quick_task, too_big
from engine.sandboxes.local_worktree import LocalWorktreeSandbox

ROOT = Path(__file__).parent.parent
WEB = ROOT / "projects" / "web_bookings"
TEMPLATE_READY = (ROOT / "templates" / "next-supabase" / "node_modules").exists()
web = pytest.mark.skipif(not TEMPLATE_READY, reason="run `npm ci` in templates/next-supabase first")
REQUEST = "Call it Pawfect grooming and make the heading green"


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


@pytest.fixture(scope="module")
def built_web(tmp_path_factory):
    """The booking site, planned, built and integrated once (one production build); each test copies it."""
    from engine.stacks import NextSupabaseStack
    base = tmp_path_factory.mktemp("built-web")
    stack = NextSupabaseStack()
    repo = build_project_repo(base / "r", stack)
    eng = Engine(repo, ScriptedTeam(WEB), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    _, results = run_project((WEB / "description.md").read_text(), repo, eng, stack=stack, parallel=3)
    assert all(r.status in ("merged", "passed") for r in results), [(r.task, r.status) for r in results]
    shutil.rmtree(base / "sandboxes", ignore_errors=True)
    git(repo, "worktree", "prune")
    return repo


def go_quick(tmp_path, built_web, agent, request=REQUEST):
    from engine.stacks import NextSupabaseStack
    repo = tmp_path / "r"
    shutil.copytree(built_web, repo, symlinks=True)
    sink = ListSink()
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    results = quick_project(1, request, repo, eng, NextSupabaseStack())
    return repo, results, sink.events


@web
def test_quick_ui_edit_merges_after_the_whole_app_check(tmp_path, built_web):
    before = git(built_web, "rev-parse", "main:src/server/bookings.ts")
    repo, results, events = go_quick(tmp_path, built_web, ScriptedTeam(WEB))
    [r] = results
    assert (r.task, r.status, len(r.attempts)) == ("Q1", "merged", 1), [(a.reason, a.test_output[-800:]) for a in r.attempts]
    assert "Pawfect grooming" in git(repo, "show", "main:src/app/page.tsx")
    assert git(repo, "rev-parse", "main:src/server/bookings.ts") == before          # nothing else touched
    out = r.attempts[0].test_output
    assert "/book" in out and "/sign-up" in out                                      # every page was requested
    kinds = [(e.kind, e.task_id) for e in events]
    assert kinds[:2] == [("quick_started", None), ("task_queued", "Q1")]
    assert events[0].data == {"n": 1, "text": REQUEST}
    assert not [e for e in events if e.kind in ("plan_ready", "change_plan_ready", "plan_decision", "quick_blocked")]
    from worker import finished
    assert finished(results) == "done" and not quick_blocked(results)


@web
def test_quick_edit_outside_the_ui_is_rejected(tmp_path, built_web):
    """Touching server code is never a quick change: both tries are turned away by scope, before any build."""
    class EditsServer(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            box.write_file("src/server/bookings.ts", box.exec("cat src/server/bookings.ts").output + "\n// tweak\n")
            return rep

    repo, results, events = go_quick(tmp_path, built_web, EditsServer(WEB))
    [r] = results
    assert r.status == "failed" and len(r.attempts) == 2
    assert all("outside its scope: src/server/bookings.ts" in a.reason for a in r.attempts)
    assert "Pawfect" not in git(repo, "show", "main:src/app/page.tsx")
    assert not [e for e in events if e.kind == "quick_blocked"]
    from worker import finished
    assert finished(results) == "failed"


@web
def test_blocked_quick_change_stops_without_retrying(tmp_path, built_web):
    calls = []

    class NeedsData(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            calls.append(attempt)
            return AgentReport("blocked: needs a change request: a pet's breed has to be stored", cost_usd=0.02)

    repo, results, events = go_quick(tmp_path, built_web, NeedsData(WEB), request="Show each pet's breed on bookings")
    [r] = results
    assert calls == [1] and r.status == "blocked" and quick_blocked(results)
    assert r.error == "needs a change request: a pet's breed has to be stored" and r.cost_usd == 0.02
    blocked = [e for e in events if e.kind == "quick_blocked"]
    assert [e.data for e in blocked] == [{"n": 1, "reason": r.error}]
    finished = [e for e in events if e.kind == "attempt_finished"]
    assert len(finished) == 1 and finished[0].data["passed"] is False and finished[0].data["cost_usd"] == 0.02
    assert not [e for e in events if e.kind == "task_status" and e.data.get("status") == "checking"]
    assert [e.data["status"] for e in events if e.kind == "task_status"][-1] == "blocked"


def test_obviously_big_requests_are_turned_away_before_any_agent(tmp_path):
    """The pre-screen is narrow on purpose: wording about sign-in or pages stays a quick change."""
    from engine.stacks import NextSupabaseStack
    assert too_big("Take payments with Stripe at checkout")
    assert too_big("Add a new page for reviews")
    assert too_big("Add a column to the database for the pet's breed")
    for ok in ("Make the sign-in button green", "Change the new page title to Book now", "Fix the spacing on /book",
               "Add a link to the sign-up page in the header", "Rename 'Create an account' to 'Join'",
               "Make the payment button blue"):
        assert too_big(ok) is None, ok

    class Never:
        def run(self, *a, **kw):
            raise AssertionError("no agent should run")

    repo = tmp_path / "r"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "plan.json").write_text(json.dumps({"project": "x", "contracts": [], "tasks": [], "pages": ["/"]}))
    sink = ListSink()
    eng = Engine(repo, Never(), lambda t, n: None, events=Emitter(sink))
    results = quick_project(2, "Take card payments", repo, eng, NextSupabaseStack())
    assert quick_blocked(results) and "payments" in results[0].error
    assert [(e.kind, e.data) for e in sink.events] == [
        ("quick_started", {"n": 2, "text": "Take card payments"}), ("quick_blocked", {"n": 2, "reason": results[0].error})]


def test_quick_task_is_ui_only_with_the_whole_app_check():
    from engine.stacks import NextSupabaseStack
    stack = NextSupabaseStack()
    t = quick_task(3, "Bigger buttons", {"pages": ["/", "/book"]}, stack)
    assert (t.id, t.role, t.max_attempts, t.merge) == ("Q3", "dev", 2, True)
    assert t.can_edit == QUICK_SCOPE and not any(p.startswith(("src/server", "src/lib", "supabase")) for p in t.can_edit)
    assert stack.integration_check_cmd(["/", "/book"]) in t.spec and "Bigger buttons" in t.spec
    assert t.check is not None and t.stop_when is blocked_reason
    with pytest.raises(QuickChangeError, match="only for web apps"):
        quick_task(1, "Bigger buttons", {"pages": ["/"]}, default_stack(sys.executable))


@pytest.mark.parametrize("claim, reason", [
    ("blocked: needs a change request: new data", "needs a change request: new data"),
    ("blocked: Needs a change request", "needs a change request"),
    ("blocked: the build keeps failing", None),
    ("done", None),
    ("error: agent run did not finish", None),
])
def test_only_a_needs_a_change_request_claim_stops_a_quick_change(claim, reason):
    assert blocked_reason(claim) == reason


def test_worker_redeploys_the_preview_after_a_quick_change_merges():
    """A done project's integration merged earlier (Convex passes `merged` in quick mode), so a merged Q1 redeploys."""
    from engine.engine import Result
    from tests.test_deploy import run_worker_preview
    calls, evs = run_worker_preview([Result("Q1", "q", "merged")], ("ready", "https://x.vercel.app", ""),
                                    merged_before={"PLAN", "T1", "INT"})
    assert calls and evs == [("preview_ready", {"url": "https://x.vercel.app"})]
    calls, _ = run_worker_preview([Result("Q1", "q", "blocked")], ("ready", "u", ""), merged_before={"INT"})
    assert calls == []
