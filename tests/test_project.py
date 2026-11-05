"""Milestone 3: description -> plan -> QA tests -> build, with the engine checking every stage."""
import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from engine.agents.scripted import ScriptedTeam
from engine.engine import Engine
from engine.interfaces import AgentReport
from engine.project import build_project_repo, default_stack, plan_problems, run_project, summary_counts, tasks_from_plan
from engine.sandboxes.local_worktree import LocalWorktreeSandbox

FIXTURE = Path(__file__).parent.parent / "projects" / "tool_library"
DESCRIPTION = (FIXTURE / "description.md").read_text()
PLAN = json.loads((FIXTURE / "plan" / "plan.json").read_text())


def go(tmp_path, agent):
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    return repo, plan, {r.task: r for r in results}


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


def test_whole_project_builds(tmp_path):
    repo, plan, res = go(tmp_path, ScriptedTeam(FIXTURE))
    assert plan["project"] == "Neighborhood tool library"
    assert {k: r.status for k, r in res.items()} == {
        "PLAN": "merged", "T1-qa": "passed", "T2-qa": "passed", "T3-qa": "passed",
        "T1": "merged", "T2": "merged", "T3": "merged"}
    assert "acceptance" not in git(repo, "ls-tree", "-r", "--name-only", "main")   # tests never merged


def test_dev_agents_never_see_acceptance_tests(tmp_path):
    seen = {}

    class Peeker(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            if task.role == "dev":
                seen[task.id] = box.exec("ls acceptance 2>/dev/null").output.strip()
            return super().run(task, box, attempt, feedback)

    go(tmp_path, Peeker(FIXTURE))
    assert seen == {"T1": "", "T2": "", "T3": ""}


def test_dev_waits_for_its_dependencies_and_its_qa(tmp_path):
    tasks = {t.id: t for t in tasks_from_plan(PLAN)}
    assert tasks["T3"].depends_on == ["T1", "T2", "T3-qa"]
    assert tasks["T1-qa"].depends_on == [] and not tasks["T1-qa"].merge
    assert tasks["T3"].can_edit == ["reports.py", "tests/test_reports*.py"]
    assert "lending.py" in tasks["T3"].spec and "cannot edit" in tasks["T3"].spec


def test_bad_plan_is_sent_back_with_reasons(tmp_path):
    feedbacks = []

    class CyclicFirst(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.role == "planner":
                feedbacks.append(feedback)
                if attempt == 1:
                    plan = copy.deepcopy(PLAN)
                    plan["tasks"][0]["depends_on"] = ["T3"]
                    box.write_file("plan.json", json.dumps(plan))
            return rep

    _, plan, res = go(tmp_path, CyclicFirst(FIXTURE))
    assert len(res["PLAN"].attempts) == 2 and "cycle" in res["PLAN"].attempts[0].reason
    assert "cycle" in feedbacks[1] and plan is not None and res["T3"].status == "merged"


def test_planner_that_never_produces_a_valid_plan_stops_everything(tmp_path):
    class NoStubs(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            box.write_file("fees.py", "def late_fee_cents(loan, tool, today):\n    return 0\n")
            return rep

    _, plan, res = go(tmp_path, NoStubs(FIXTURE))
    assert plan is None and list(res) == ["PLAN"] and res["PLAN"].status == "failed"
    assert "must be stubs" in res["PLAN"].attempts[0].reason


def test_stubs_that_dont_import_are_rejected(tmp_path):
    class Broken(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.role == "planner" and attempt == 1:
                box.write_file("reports.py", "from models import Nope\nraise NotImplementedError\n")
            return rep

    _, _, res = go(tmp_path, Broken(FIXTURE))
    assert "don't pass the checks" in res["PLAN"].attempts[0].reason and res["PLAN"].status == "merged"


@pytest.mark.parametrize("plan_edit,msg", [
    (lambda p: p["tasks"][1].update(module="lending.py"), "already owned"),
    (lambda p: p["tasks"][0].update(depends_on=["T9"]), "T9"),
    (lambda p: p.update(tasks=p["tasks"][:1]), "2 to"),
    (lambda p: p["tasks"][0].update(module="pkg/lending.py"), "top-level"),
    (lambda p: p["tasks"][0].update(spec=""), "spec"),
    (lambda p: p.update(contracts=["models.py", "lending.py"]), "already owned"),
])
def test_plan_structure_rules(plan_edit, msg):
    plan = copy.deepcopy(PLAN)
    plan_edit(plan)
    assert any(msg in p for p in plan_problems(plan)), plan_problems(plan)
    assert plan_problems(PLAN) == []


@pytest.mark.parametrize("bad_tests,msg", [
    ("def test_a():\n    assert True\ndef test_b():\n    assert True\ndef test_c():\n    assert True\n",
     "already pass"),
    ("from fees import late_fee_cents\ndef test_a(:\n    pass\n", "don't run cleanly"),
    ("from fees import late_fee_cents\nfrom models import Loan, Tool\nfrom datetime import date\n"
     "def test_a():\n    late_fee_cents(None, None, None)\n", "at least 3"),
    ("def test_a():\n    assert 1 == 2\ndef test_b():\n    assert 1 == 2\ndef test_c():\n    assert 1 == 2\n",
     "not because the code is unimplemented"),
])
def test_useless_qa_tests_are_rejected(tmp_path, bad_tests, msg):
    class BadQA(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T2-qa" and attempt == 1:
                box.write_file(task.can_edit[0], bad_tests)
            return rep

    _, _, res = go(tmp_path, BadQA(FIXTURE))
    assert msg in res["T2-qa"].attempts[0].reason
    assert res["T2-qa"].status == "passed" and res["T2"].status == "merged"   # fixed on retry


def test_qa_failure_blocks_only_its_dev_task_and_dependents(tmp_path):
    class LazyQA(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            if task.id == "T2-qa":
                return AgentReport("done")                       # writes nothing
            return super().run(task, box, attempt, feedback)

    _, _, res = go(tmp_path, LazyQA(FIXTURE))
    assert res["T2-qa"].status == "failed"
    assert res["T2"].status == "blocked" and res["T3"].status == "blocked"
    assert res["T1"].status == "merged"


def test_summary_counts():
    assert summary_counts("....\n3 failed, 2 passed in 0.1s") == {"failed": 3, "passed": 2}
    assert summary_counts("1 failed, 1 error in 0.1s") == {"failed": 1, "error": 1}


# ------------------------------------------------------------- milestone 4: live events + approval
def go_with(tmp_path, agent, **kw):
    from engine.events import Emitter, ListSink
    sink = ListSink()
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable, **kw)
    return sink.events, plan, {r.task: r for r in results}


def test_events_trace_every_task_from_queued_to_finished(tmp_path):
    events, _, res = go_with(tmp_path, ScriptedTeam(FIXTURE))
    kinds = [e.kind for e in events]
    assert kinds.index("plan_ready") < kinds.index("plan_decision") < kinds.index("attempt_finished", kinds.index("plan_decision"))
    for tid, r in res.items():
        statuses = [e.data["status"] for e in events if e.kind == "task_status" and e.task_id == tid]
        assert statuses[0] == "working" and statuses[-1] == r.status, (tid, statuses)
        assert any(e.kind == "task_queued" and e.task_id == tid for e in events)
    t3 = next(e for e in events if e.kind == "task_queued" and e.task_id == "T3")
    assert t3.data["depends_on"] == ["T1", "T2", "T3-qa"] and t3.data["role"] == "dev"


def test_rejected_plan_builds_nothing(tmp_path):
    calls = []

    class Spy(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            calls.append(task.role)
            return super().run(task, box, attempt, feedback)

    events, plan, res = go_with(tmp_path, Spy(FIXTURE), approve=lambda p: (False, "too many tasks"))
    assert plan is not None and list(res) == ["PLAN"] and calls == ["planner"]
    decision = next(e for e in events if e.kind == "plan_decision")
    assert decision.data == {"approved": False, "note": "too many tasks"}


def test_blocked_tasks_emit_a_status(tmp_path):
    class LazyQA(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            if task.id == "T2-qa":
                return AgentReport("done")
            return super().run(task, box, attempt, feedback)

    events, _, _ = go_with(tmp_path, LazyQA(FIXTURE))
    blocked = {e.task_id for e in events if e.kind == "task_status" and e.data["status"] == "blocked"}
    assert blocked == {"T2", "T3"}


def test_a_broken_sink_never_breaks_a_build(tmp_path):
    from engine.events import Emitter

    class Broken:
        def write(self, event):
            raise OSError("disk full")

    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, ScriptedTeam(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(Broken()))
    _, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    assert all(r.status in ("merged", "passed") for r in results), \
        [(r.task, r.status, r.error, [a.reason for a in r.attempts]) for r in results]


# ------------------------------------------------------- phase 1: Next.js + Supabase web apps
WEB = Path(__file__).parent.parent / "projects" / "web_bookings"
TEMPLATE_READY = (Path(__file__).parent.parent / "templates" / "next-supabase" / "node_modules").exists()
web = pytest.mark.skipif(not TEMPLATE_READY, reason="run `npm ci` in templates/next-supabase first")


def go_web(tmp_path, agent, integrate=False):
    from engine.stacks import NextSupabaseStack
    stack = NextSupabaseStack()
    stack.integration = integrate          # a production build per run; only the integration tests pay for it
    repo = build_project_repo(tmp_path / "r", stack)
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    plan, results = run_project((WEB / "description.md").read_text(), repo, eng, stack=stack, parallel=3)
    return repo, plan, {r.task: r for r in results}


@web
def test_web_project_plans_tests_and_builds(tmp_path):
    repo, plan, res = go_web(tmp_path, ScriptedTeam(WEB), integrate=True)
    assert {k: r.status for k, r in res.items()} == {
        "PLAN": "merged", "T1-qa": "passed", "T2-qa": "passed", "T3-qa": "passed",
        "T1": "merged", "T2": "merged", "T3": "merged", "INT": "merged"}, \
        {k: [a.reason for a in r.attempts] for k, r in res.items()}
    tracked = git(repo, "ls-tree", "-r", "--name-only", "main").split()
    assert "src/server/bookings.ts" in tracked and "node_modules" not in tracked
    # the integrator ran last and wired the design's pages; its check built the app and requested each page
    assert {"src/app/book/page.tsx", "src/app/sign-up/page.tsx"} <= set(tracked)
    assert "INT" == list(res)[-1] and plan["pages"] == ["/", "/sign-up", "/book"]
    assert not [f for f in tracked if f.startswith("tests/acceptance/")]          # hidden tests never merged


@web
def test_web_integration_that_crashes_a_page_or_skips_one_is_sent_back(tmp_path):
    """The integrator's work counts only if the whole app builds and every page the design needs answers
    without a server error. Try 1 throws on /book; try 2 forgets /book; try 3 is right."""
    class Integrator(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "INT" and attempt == 1:
                box.write_file("src/app/book/page.tsx", 'export const dynamic = "force-dynamic";\n'
                               'export default function Book(): never { throw new Error("db is down"); }\n')
            if task.id == "INT" and attempt == 2:
                box.exec("rm -rf src/app/book")
            return rep

    _, _, res = go_web(tmp_path, Integrator(WEB), integrate=True)
    tries = res["INT"].attempts
    assert res["INT"].status == "merged" and len(tries) == 3
    assert "FAIL /book -> 500" in tries[0].test_output
    assert "FAIL /book -> 404 (required page is missing)" in tries[1].test_output


@web
def test_web_integration_goes_ahead_without_a_failed_screen(tmp_path):
    """Regression (Pawfect builds 6-7): the owner screens never passed their tests and blocked the whole app.
    Server features stay required; a failed screen component no longer blocks the integrator."""
    from engine.events import Emitter, ListSink
    from engine.stacks import NextSupabaseStack

    class BrokenPicker(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T3":
                box.write_file("src/components/SlotPicker.tsx", 'export function SlotPicker(): null { return null; }\n')
            return rep

    sink = ListSink()
    stack = NextSupabaseStack()
    repo = build_project_repo(tmp_path / "r", stack)
    eng = Engine(repo, BrokenPicker(WEB), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    _, results = run_project((WEB / "description.md").read_text(), repo, eng, stack=stack, parallel=3)
    res = {r.task: r.status for r in results}
    assert res["T3"] == "failed" and res["INT"] == "merged", res
    assert [e.data for e in sink.events if e.task_id == "INT" and e.data.get("status") == "without"] == \
        [{"status": "without", "missing": ["T3"]}]
    from worker import finished
    assert finished(results) == "done"


def test_integration_task_only_for_web_and_scoped_to_pages():
    from engine.project import integration_task
    from engine.stacks import NextSupabaseStack
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    t = integration_task(plan, "A booking site", NextSupabaseStack(link_node_modules=False))
    assert t.depends_on == ["T1", "T2"] and t.waits_for == ["T3"] and t.check and not t.hidden_tests
    assert t.can_edit == ["src/app/*", "src/middleware.ts", "tests/unit/*"]
    assert "/sign-up" in t.spec and "src/server/bookings.ts" in t.spec and "next build" in t.spec
    assert not default_stack().integration
    bad = dict(plan, pages=["/p/[id]"])
    assert any('"pages"' in m for m in plan_problems(bad, NextSupabaseStack(link_node_modules=False)))


@web
def test_web_dev_work_that_fails_types_or_tests_is_rejected(tmp_path):
    class Sloppy(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T2" and attempt == 1:       # type error
                box.write_file("src/server/bookings.ts", (WEB / "solutions/src/server/bookings.ts").read_text()
                               .replace("return toBooking(u.rows[0]);", "return u.rows[0].nope;"))
            if task.id == "T1" and attempt == 1:       # compiles, wrong behavior: ignores time zone
                box.write_file("src/server/slots.ts", (WEB / "solutions/src/server/slots.ts").read_text()
                               .replace("(s.starts_at at time zone $2)::date = $1::date", "s.starts_at::date = $1::date and $2::text is not null"))
            return rep

    _, _, res = go_web(tmp_path, Sloppy(WEB))
    assert res["T1"].status == res["T2"].status == "merged"
    assert len(res["T1"].attempts) == 2 and res["T1"].attempts[0].reason == "acceptance tests failed"
    assert len(res["T2"].attempts) == 2 and "error TS" in res["T2"].attempts[0].test_output


@web
def test_web_qa_tests_must_fail_on_the_stub_for_the_right_reason(tmp_path):
    class LazyQA(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T3-qa" and attempt == 1:
                box.write_file(task.can_edit[0], 'import { it, expect } from "vitest";\n'
                               'it("a", () => expect(1).toBe(1));\nit("b", () => expect(2).toBe(2));\nit("c", () => expect(3).toBe(3));\n')
            return rep

    _, _, res = go_web(tmp_path, LazyQA(WEB))
    assert "already pass" in res["T3-qa"].attempts[0].reason and res["T3"].status == "merged"


def test_web_plan_rules():
    from engine.stacks import NextSupabaseStack
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    st = NextSupabaseStack(link_node_modules=False)
    assert plan_problems(plan, st) == []
    bad = copy.deepcopy(plan)
    bad["tasks"][0]["module"] = "lib/slots.py"
    bad["contracts"].append("db.sql")
    msgs = " ".join(plan_problems(bad, st))
    assert "src/server/" in msgs and "migration" in msgs
    assert st.qa_test_path("src/components/SlotPicker.tsx") == "tests/acceptance/components-slotpicker.test.tsx"


def test_vitest_summary_parsing():
    from engine.stacks import NextSupabaseStack
    st = NextSupabaseStack(link_node_modules=False)
    assert st.counts(" Test Files  1 failed (1)\n      Tests  3 failed | 1 passed (4)\n") == {"passed": 1, "failed": 3, "errors": 0}
    assert st.counts(" Test Files  1 failed (1)\n      Tests  no tests\n")["errors"] == 1
    # Regression (first CI run): GitHub's runner turns colors on, and color codes broke the parsing.
    colored = "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m3 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1 passed\x1b[39m (4)"
    assert st.counts(colored) == {"passed": 1, "failed": 3, "errors": 0}


@web
def test_web_plan_listing_template_files_as_contracts_is_accepted(tmp_path):
    """Regression (fourth web run): the planner listed the template's 0000_base.sql as a contract and a
    good plan was rejected. Template files are dropped from the list instead."""
    class ListsBase(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.role == "planner":
                plan = json.loads((WEB / "plan" / "plan.json").read_text())
                plan["contracts"].insert(0, "supabase/migrations/0000_base.sql")
                box.write_file("plan.json", json.dumps(plan))
            return rep

    _, plan, res = go_web(tmp_path, ListsBase(WEB))
    assert res["PLAN"].status == "merged" and len(res["PLAN"].attempts) == 1
    assert "supabase/migrations/0000_base.sql" not in plan["contracts"]


@web
def test_web_plan_that_touches_template_files_is_accepted(tmp_path):
    """Regression (Pawfect rebuild): the planner edited src/app/page.tsx without listing it, then listed
    src/test/db.ts and src/app/layout.tsx as contracts, and lost the plan twice. Template edits that the
    plan doesn't own are undone, and template files listed as contracts are dropped."""
    class TouchesTemplate(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.role == "planner":
                plan = json.loads((WEB / "plan" / "plan.json").read_text())
                plan["contracts"] += ["src/test/db.ts", "src/app/layout.tsx"]
                box.write_file("plan.json", json.dumps(plan))
                box.write_file("src/app/page.tsx", "export default function Home() { return null; }\n")
            return rep

    repo, plan, res = go_web(tmp_path, TouchesTemplate(WEB))
    assert res["PLAN"].status == "merged" and len(res["PLAN"].attempts) == 1
    assert not {"src/test/db.ts", "src/app/layout.tsx"} & set(plan["contracts"])
    assert "return null" not in subprocess.run(["git", "show", "main:src/app/page.tsx"], cwd=repo,
                                               capture_output=True, text=True).stdout


@web
def test_web_qa_tests_importing_a_file_no_task_builds_are_rejected(tmp_path):
    """Regression (Pawfect build): a QA test dynamically imported an API route that no task owned. Every other
    test failed on the stub as it should, so it was accepted, and the feature could never pass."""
    class ImportsRoute(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T3-qa" and attempt == 1:
                path = task.can_edit[0]
                body = (WEB / path).read_text() + (
                    '\nit("cron route", async () => {\n'
                    '  const m = await import("@/app/api/cron/emails/route");\n'
                    '  expect(m).toBeTruthy();\n});\n')
                box.write_file(path, body)
            return rep

    _, _, res = go_web(tmp_path, ImportsRoute(WEB))
    first = res["T3-qa"].attempts[0]
    assert "src/app/api/cron/emails/route" in first.reason and "no task builds" in first.reason
    assert res["T3"].status == "merged"


def test_failures_carry_their_output_and_hidden_tests_are_saved(tmp_path):
    """Regression (first live build): two features failed 3 times and nobody could see why, because
    attempt events had no test output and the hidden tests were gone after the run."""
    from engine.events import Emitter, ListSink

    class WrongFees(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T2" and attempt == 1:
                box.write_file("fees.py", "def late_fee_cents(loan, tool, today):\n    return 1\n")
            return rep

    sink = ListSink()
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, WrongFees(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    _, results = run_project(DESCRIPTION, repo, eng, python=sys.executable, save_tests=tmp_path / "saved")
    failed = [e for e in sink.events if e.kind == "attempt_finished" and not e.data["passed"]]
    assert failed, [(r.task, r.status, r.error, [a.reason for a in r.attempts]) for r in results]   # flaked once in CI
    assert "assert" in failed[0].data["output"]
    assert (tmp_path / "saved" / "acceptance" / "test_fees.py").exists()


# --------------------------------------------------------------------------- referee
class WrongFeeTest(ScriptedTeam):
    """QA writes a test whose expected value contradicts the spec (2 days late at 300/day is 600, not 700),
    as happened in both live builds."""
    def run(self, task, box, attempt, feedback):
        rep = super().run(task, box, attempt, feedback)
        if task.id == "T2-qa":
            box.write_file(task.can_edit[0], (FIXTURE / task.can_edit[0]).read_text().replace("== 600", "== 700"))
        return rep


def go_ref(tmp_path, team, referee):
    from engine.events import Emitter, ListSink
    sink = ListSink()
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, team, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    _, results = run_project(DESCRIPTION, repo, eng, python=sys.executable, referee=referee)
    return {r.task: r for r in results}, sink.events


def test_referee_fixes_a_wrong_qa_test_and_the_feature_merges(tmp_path):
    res, events = go_ref(tmp_path, WrongFeeTest(FIXTURE), referee=ScriptedTeam(FIXTURE))
    assert res["T2"].status == "merged" and len(res["T2"].attempts) == 2
    assert [e.data for e in events if e.kind == "dispute_resolved"] == [{"test_fixed": True}]
    assert res["T3"].status == "merged"                      # downstream no longer blocked


def test_referee_gets_a_second_look_when_its_first_fix_was_real(tmp_path):
    """Regression (Pawfect build 6): the referee fixed one batch of bad tests, the dev then failed on two more
    and the feature was lost. A referee that fixed something gets one more review, and sees the dev's message."""
    class TwoBadTests(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T2-qa":
                body = (FIXTURE / task.can_edit[0]).read_text().replace("== 600", "== 700").replace("== 900", "== 901")
                box.write_file(task.can_edit[0], body)
            if task.id == "T2" and attempt == 2:
                return AgentReport("blocked: the 901 test is wrong, 3 days at 300 is 900")
            return rep

    seen = []

    class FixesOneAtATime:
        def run(self, task, box, attempt, feedback):
            seen.append(task.spec)
            path = task.can_edit[0]
            body = box.exec(f"cat {path}").output
            box.write_file(path, body.replace("== 700", "== 600") if "== 700" in body else body.replace("== 901", "== 900"))
            return AgentReport("done")

    res, events = go_ref(tmp_path, TwoBadTests(FIXTURE), referee=FixesOneAtATime())
    assert res["T2"].status == "merged" and len(res["T2"].attempts) == 3, \
        ([(a.claim, a.reason, a.test_output[-300:]) for a in res["T2"].attempts],
         [e.data for e in events if e.kind == "dispute_resolved"])
    assert [e.data for e in events if e.kind == "dispute_resolved"] == [{"test_fixed": True}, {"test_fixed": True}]
    assert "3 days at 300 is 900" in seen[1]                 # the dev's own explanation reached the referee


def test_referee_that_confirms_the_tests_changes_nothing(tmp_path):
    class Confirms:
        def run(self, task, box, attempt, feedback):
            return AgentReport("blocked: tests are correct")

    res, events = go_ref(tmp_path, WrongFeeTest(FIXTURE), referee=Confirms())
    assert res["T2"].status == "failed" and len(res["T2"].attempts) == 3
    assert [e.data for e in events if e.kind == "dispute_resolved"] == [{"test_fixed": False}]
    assert res["T3"].status == "blocked"


def test_referee_that_crashes_is_not_reported_as_confirming(tmp_path):
    """Regression (Pawfect build): the referee hit an API error and the feed said it confirmed the tests."""
    class Crashes:
        def run(self, task, box, attempt, feedback):
            return AgentReport("error: agent run did not finish (API Error: 529 overloaded)")

    res, events = go_ref(tmp_path, WrongFeeTest(FIXTURE), referee=Crashes())
    assert [e.data for e in events if e.kind == "dispute_resolved"] == [{"test_fixed": False, "referee_error": True}]
    assert res["T2"].status == "failed"


def test_referee_edits_that_break_qa_rules_are_rejected(tmp_path):
    class Gutter:
        def run(self, task, box, attempt, feedback):
            box.write_file(task.can_edit[0], "def test_a():\n    assert True\n")   # "fixes" by deleting tests
            return AgentReport("done")

    res, events = go_ref(tmp_path, WrongFeeTest(FIXTURE), referee=Gutter())
    assert [e.data for e in events if e.kind == "dispute_resolved"] == [{"test_fixed": False}]
    assert res["T2"].status == "failed"


# --------------------------------------------------------------------------- retry what failed
def test_retry_reruns_only_what_did_not_merge(tmp_path):
    """Regression (Pawfect builds 3, 6, 7): one feature failing cost the whole build, because the only way
    on was to plan and build all of it again. A retry keeps merged work and redoes the rest in the same repo."""
    from engine.events import Emitter, ListSink
    from engine.project import resume_project

    class NeverFixesFees(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "T2":
                box.write_file("fees.py", "def late_fee_cents(loan, tool, today):\n    return 1\n")
            return rep

    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, NeverFixesFees(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    first = {r.task: r.status for r in results}
    assert first["T1"] == "merged" and first["T2"] == "failed" and first["T3"] == "blocked"
    merged = {t for t, s in first.items() if s == "merged" and not t.endswith("-qa")}

    calls = []

    class Fixed(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            calls.append(task.id)
            return super().run(task, box, attempt, feedback)

    sink = ListSink()
    eng2 = Engine(repo, Fixed(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    again = {r.task: r.status for r in resume_project(plan, DESCRIPTION, repo, eng2, merged)}
    assert again == {"T2-qa": "passed", "T2": "merged", "T3-qa": "passed", "T3": "merged"}
    assert not [c for c in calls if c.startswith("T1")] and "PLAN" not in calls      # merged work untouched
    resumed = [e.data for e in sink.events if e.kind == "build_resumed"]
    assert resumed == [{"merged": ["PLAN", "T1"], "retrying": ["T2", "T3"]}]


def test_retry_includes_the_integration_for_web_apps():
    from engine.project import resume_tasks
    from engine.stacks import NextSupabaseStack
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    todo = resume_tasks(plan, "x", NextSupabaseStack(link_node_modules=False), {"T1", "T3"})
    assert [t.id for t in todo] == ["T2-qa", "T2", "INT"]
    assert next(t for t in todo if t.id == "T2").depends_on == ["T2-qa"]     # T1 is merged: nothing to wait for
    assert next(t for t in todo if t.id == "INT").depends_on == ["T2"]


# --------------------------------------------------------------------------- change requests
CHANGE_DIR = FIXTURE / "changes" / "1"
CHANGE = json.loads((CHANGE_DIR / "plan" / "changes" / "1.json").read_text())
REQUEST = "One free day before late fees, please. And renewals!"        # the user's words win over the planner's


@pytest.fixture(scope="module")
def built_repo(tmp_path_factory):
    """The tool library, planned and built once; each change test works on its own copy."""
    import shutil
    base = tmp_path_factory.mktemp("built")
    repo = build_project_repo(base / "r")
    eng = Engine(repo, ScriptedTeam(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    _, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    assert all(r.status in ("merged", "passed") for r in results)
    shutil.rmtree(base / "sandboxes", ignore_errors=True)
    git(repo, "worktree", "prune")
    return repo


def go_change(tmp_path, built_repo, agent, approve=None, referee=None):
    import shutil
    from engine.events import Emitter, ListSink
    from engine.project import auto_approve, change_project
    repo = tmp_path / "r"
    shutil.copytree(built_repo, repo, symlinks=True)
    sink = ListSink()
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    change, results = change_project(1, REQUEST, DESCRIPTION, repo, eng, approve=approve or auto_approve,
                                     stack=default_stack(sys.executable), referee=referee)
    return repo, change, {r.task: r for r in results}, sink.events


def tree(repo):
    return dict(line.split(None, 3)[2:4][::-1] for line in git(repo, "ls-tree", "-r", "main").splitlines())


def test_change_plans_approves_builds_and_updates_the_plan(tmp_path, built_repo):
    before = tree(built_repo)
    seen = []
    repo, change, res, events = go_change(tmp_path, built_repo, ScriptedTeam(FIXTURE),
                                          approve=lambda c: (seen.append(c), (True, "ok"))[1])
    assert {k: r.status for k, r in res.items()} == {
        "C1PLAN": "merged", "C1T1-qa": "passed", "C1T1": "merged", "C1T2-qa": "passed", "C1T2": "merged"}, \
        {k: [a.reason for a in r.attempts] for k, r in res.items()}
    assert seen == [change] and change["request"] == REQUEST and change["n"] == 1
    after = tree(repo)
    for f in ("lending.py", "reports.py", "models.py"):                     # merged work untouched
        assert after[f] == before[f], f
    assert after["fees.py"] != before["fees.py"] and "renewals.py" in after and "changes/1.json" in after
    assert not [f for f in after if f.startswith("acceptance/")]           # hidden tests never merged
    plan = json.loads(git(repo, "show", "main:plan.json"))
    assert [t["id"] for t in plan["tasks"]] == ["T1", "T2", "T3", "C1T2"]
    assert plan["tasks"][1]["spec"] == CHANGE["tasks"][0]["spec"]          # T2 owns fees.py: its spec is replaced
    assert plan["tasks"][3]["depends_on"] == ["T2"] and plan_problems(plan) == []
    kinds = [(e.kind, e.task_id) for e in events]
    assert kinds[:2] == [("change_started", None), ("task_queued", "C1PLAN")]
    assert events[0].data == {"n": 1, "text": REQUEST}
    assert next(e for e in events if e.task_id == "C1PLAN" and e.kind == "task_queued").data["role"] == "planner"
    ready = next(e for e in events if e.kind == "change_plan_ready")
    assert ready.data == {"n": 1, "change": change}
    assert kinds.index(("change_plan_ready", None)) < kinds.index(("plan_decision", None)) < kinds.index(("task_queued", "C1T1-qa"))
    assert next(e for e in events if e.kind == "task_queued" and e.task_id == "C1T2").data["depends_on"] == ["C1T1", "C1T2-qa"]


def test_rejected_change_builds_nothing_and_leaves_main_as_it_was(tmp_path, built_repo):
    calls = []

    class Spy(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            calls.append(task.id)
            return super().run(task, box, attempt, feedback)

    repo, change, res, events = go_change(tmp_path, built_repo, Spy(FIXTURE), approve=lambda c: (False, "not now"))
    assert list(res) == ["C1PLAN"] and calls == ["C1PLAN"] and change is not None
    assert next(e for e in events if e.kind == "plan_decision").data == {"approved": False, "note": "not now"}
    # its doc comments and changes/1.json were merged for review, and reverted: nobody approved that spec
    assert tree(repo) == tree(built_repo)


@pytest.mark.parametrize("edit,msg", [
    (lambda c: c["tasks"][0].update(id="T4"), "C1T1, C1T2"),
    (lambda c: c["tasks"][0].update(kind="fix"), '"kind"'),
    (lambda c: c["tasks"][0].update(module="nope.py"), "needs a module that exists"),
    (lambda c: c["tasks"][1].update(module="lending.py"), 'kind "new" needs a new module'),
    (lambda c: c["tasks"][1].update(module="fees.py"), "already owned"),
    (lambda c: c["tasks"][1].update(depends_on=["T1"]), "only name tasks in this change"),
    (lambda c: c["tasks"][0].update(depends_on=["C1T2"]), "cycle"),
    (lambda c: c.update(contracts=["fees.py"]), "not a contract"),
    (lambda c: c["tasks"][0].update(module="models.py"), "isn't a task module"),
    (lambda c: c.update(tasks=[]), "1 to"),
    (lambda c: c.update(summary=" "), "summary"),
])
def test_change_structure_rules(edit, msg):
    from engine.project import change_problems
    files = {"models.py", "lending.py", "fees.py", "reports.py", "plan.json", "AGENTS.md"}
    assert change_problems(CHANGE, PLAN, default_stack(), files) == []
    bad = copy.deepcopy(CHANGE)
    edit(bad)
    problems = change_problems(bad, PLAN, default_stack(), files)
    assert any(msg in p for p in problems), problems


def test_web_change_rules():
    """Migrations are applied in order and never edited; pages get no task (the integrator makes them)."""
    from engine.project import change_problems
    from engine.stacks import NextSupabaseStack
    st = NextSupabaseStack(link_node_modules=False)
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    files = {"supabase/migrations/0000_base.sql", "supabase/migrations/0001_bookings.sql", "src/contracts/types.ts",
             "src/server/slots.ts", "src/server/bookings.ts", "src/components/SlotPicker.tsx", "src/app/page.tsx"}
    ok = {"n": 2, "request": "r", "summary": "s", "pages": ["/", "/book"],
          "contracts": ["supabase/migrations/0002_tz.sql", "src/contracts/types.ts"],
          "tasks": [{"id": "C2T1", "kind": "change", "title": "t", "module": "src/server/bookings.ts", "spec": "s"},
                    {"id": "C2T2", "kind": "new", "title": "t", "module": "src/components/Reviews.tsx", "spec": "s",
                     "depends_on": ["C2T1"]}]}
    assert change_problems(ok, plan, st, files) == []

    def problems(**kw):
        return " ".join(change_problems({**copy.deepcopy(ok), **kw}, plan, st, files))
    assert "never edit an existing migration" in problems(contracts=["supabase/migrations/0001_bookings.sql"])
    assert "numbered after the last one (0001)" in problems(contracts=["supabase/migrations/0001_tz.sql"])
    assert "must be a migration" in problems(contracts=["supabase/migrations/0000_base.sql"])    # template file
    page = [{"id": "C2T1", "kind": "change", "title": "t", "module": "src/app/page.tsx", "spec": "s"}]
    assert "get no task of their own" in problems(tasks=page)
    assert '"pages"' in problems(pages=[])


def test_change_integration_waits_for_the_change_and_carries_its_summary():
    from engine.project import integration_task
    from engine.stacks import NextSupabaseStack
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    change = {"n": 1, "request": "Keep the groomer", "summary": "Bookings keep the groomer when the date changes.",
              "contracts": [], "pages": ["/", "/book", "/my-bookings"],
              "tasks": [{"id": "C1T1", "kind": "change", "title": "Keep groomer", "module": "src/server/bookings.ts",
                         "spec": "s", "depends_on": []},
                        {"id": "C1T2", "kind": "new", "title": "List", "module": "src/components/MyBookings.tsx",
                         "spec": "s", "depends_on": []}]}
    t = integration_task(plan, "A booking site", NextSupabaseStack(link_node_modules=False), change=change)
    assert t.id == "INT" and t.depends_on == ["C1T1"] and t.waits_for == ["C1T2"]
    assert "Bookings keep the groomer" in t.spec and "/my-bookings" in t.spec
    assert "src/components/MyBookings.tsx" in t.spec and "src/server/slots.ts" in t.spec    # every module, old and new


def test_change_qa_may_pass_on_unchanged_behavior_but_one_test_must_fail(tmp_path, built_repo):
    regression_only = (
        "from datetime import date\nfrom fees import late_fee_cents\nfrom models import Loan, Tool\n"
        "L = Loan(1, 1, 1, date(2026, 11, 1), date(2026, 11, 5))\nT = Tool(1, 'd', 300)\n"
        "def test_a():\n    assert late_fee_cents(L, T, date(2026, 11, 5)) == 0\n"
        "def test_b():\n    assert late_fee_cents(L, T, date(2026, 11, 1)) == 0\n"
        "def test_c():\n    assert late_fee_cents(L, T, date(2027, 1, 1)) == 5000\n")

    class RegressionOnlyFirst(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1T1-qa" and attempt == 1:
                box.write_file(task.can_edit[0], regression_only)
            return rep

    _, _, res, _ = go_change(tmp_path, built_repo, RegressionOnlyFirst(FIXTURE))
    first, second = res["C1T1-qa"].attempts
    assert "every test passes on the current code" in first.reason
    assert second.passed and "2 failed, 2 passed" in second.test_output       # regression tests may pass
    assert res["C1T1"].status == res["C1T2"].status == "merged"


REGRESSION_ONLY = (
    "from datetime import date\nfrom fees import late_fee_cents\nfrom models import Loan, Tool\n"
    "L = Loan(1, 1, 1, date(2026, 11, 1), date(2026, 11, 5))\nT = Tool(1, 'd', 300)\n"
    "def test_a():\n    assert late_fee_cents(L, T, date(2026, 11, 5)) == 0\n"
    "def test_b():\n    assert late_fee_cents(L, T, date(2026, 11, 1)) == 0\n"
    "def test_c():\n    assert late_fee_cents(L, T, date(2027, 1, 1)) == 5000\n")


@pytest.mark.parametrize("verdict", ["YES", "NO"])
def test_change_that_already_holds_is_confirmed_by_a_reviewer_then_checked_on_main(tmp_path, built_repo, verdict):
    """Regression (Pawfect change 1): the time-zone fix was complete once the change's migration set the salon's
    zone, every QA test passed on the current code, the old rule demanded a failing test, and 4 of 5 tasks were
    lost. Now a suite that passes in full is accepted if a different model confirms it tests the change; the
    engine then runs the task's checks on main and skips the dev agent. Without that confirmation, the old rule
    stands (tests of unchanged behavior alone must never declare a change done)."""
    devs = []

    class AllPass(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            if task.id == "C1T1":
                devs.append(attempt)
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1T1-qa":
                box.write_file(task.can_edit[0], REGRESSION_ONLY)
            return rep

    class Reviewer:
        def run(self, task, box, attempt, feedback):
            box.write_file(task.can_edit[0], verdict + "\n")
            return AgentReport("done")

    _, _, res, events = go_change(tmp_path, built_repo, AllPass(FIXTURE), referee=Reviewer())
    assert res["C1T1-qa"].status == "passed"
    if verdict == "YES":
        assert res["C1T1"].status == "merged" and not devs
        assert [e.task_id for e in events if e.data.get("status") == "already_done"] == ["C1T1"]
    else:
        assert res["C1T1"].status == "failed" and "didn't confirm" in res["C1T1"].error and not devs
        assert not [e for e in events if e.data.get("status") == "already_done"]
    # the review never ran inside the QA task's sandbox (two at once per task hit the provider's memory limit)
    order = [e.task_id for e in events if e.kind == "task_status" and e.task_id in ("C1T1-qa", "C1T1-confirm")]
    assert order[-1] == "C1T1-confirm" and order.index("C1T1-confirm") > max(
        i for i, t in enumerate(order) if t == "C1T1-qa")


@pytest.mark.parametrize("fees", [
    'def late_fee_cents(loan, tool, today):\n    """Free first day; then (days late - 1) * fee, capped at 5000."""\n'
    '    raise NotImplementedError\n',
    'def late_fee_cents(loan, tool, today):\n    """Free first day; then (days late - 1) * fee, capped at 5000."""\n'
    '    return 0\n',
])
def test_change_planner_cannot_stub_out_an_existing_module(tmp_path, built_repo, fees):
    class StubsFees(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1PLAN" and attempt == 1:
                box.write_file("fees.py", fees)
            return rep

    repo, _, res, _ = go_change(tmp_path, built_repo, StubsFees(FIXTURE))
    assert "keep its code exactly as it is" in res["C1PLAN"].attempts[0].reason
    assert res["C1PLAN"].status == "merged" and res["C1T1"].status == "merged"


def test_change_planner_stray_edits_are_undone_and_unchanged_docs_rejected(tmp_path, built_repo):
    class Strays(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1PLAN":
                box.write_file("plan.json", "{}")                          # the engine owns plan.json
                box.write_file("lending.py", "# rewritten\n")              # not part of the change
                if attempt == 1:
                    box.exec("git checkout HEAD -- fees.py")               # forgot fees.py's doc comments
            return rep

    repo, _, res, _ = go_change(tmp_path, built_repo, Strays(FIXTURE))
    assert "update the doc comments of fees.py" in res["C1PLAN"].attempts[0].reason
    assert res["C1PLAN"].status == "merged" and len(res["C1PLAN"].attempts) == 2
    assert tree(repo)["lending.py"] == tree(built_repo)["lending.py"]
    assert json.loads(git(repo, "show", "main:plan.json"))["project"] == PLAN["project"]


def test_a_failed_change_is_retried_from_the_change_file(tmp_path, built_repo):
    """The app retries a change run through the resume path. A "change" task can't come from plan.json (its
    module's task, T2, merged long ago), so resume_project also redoes the latest change's unmerged tasks."""
    from engine.events import Emitter, ListSink
    from engine.project import resume_project

    class NeverFixesFees(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1T1":
                box.write_file("fees.py", "def late_fee_cents(loan, tool, today):\n    return 1\n")
            return rep

    repo, _, res, _ = go_change(tmp_path, built_repo, NeverFixesFees(FIXTURE))
    assert res["C1T1"].status == "failed" and res["C1T2"].status == "blocked"
    plan = json.loads((repo / "plan.json").read_text())                    # recorded before the build
    assert [t["id"] for t in plan["tasks"]][-1] == "C1T2"
    merged = {"PLAN", "T1", "T2", "T3", "C1PLAN"}
    sink = ListSink()
    eng = Engine(repo, ScriptedTeam(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    again = {r.task: r.status for r in resume_project(plan, DESCRIPTION, repo, eng, merged,
                                                     stack=default_stack(sys.executable))}
    assert again == {"C1T1-qa": "passed", "C1T1": "merged", "C1T2-qa": "passed", "C1T2": "merged"}, again
    assert [e.data["retrying"] for e in sink.events if e.kind == "build_resumed"] == [["C1T1", "C1T2"]]


@web
def test_web_change_adds_a_migration_and_never_edits_an_old_one(tmp_path):
    """A web change end to end (without the integration build): the planner's first try edits the applied
    migration and is sent back; the second adds 0002, which the check applies on a fresh database; QA's
    change tests fail on the 60-character code and pass on the 40-character fix."""
    from engine.project import change_project
    from engine.stacks import NextSupabaseStack

    class EditsOldMigration(ScriptedTeam):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            if task.id == "C1PLAN" and attempt == 1:
                path = "supabase/migrations/0001_bookings.sql"
                box.write_file(path, box.exec(f"cat {path}").output.replace("between 1 and 60", "between 1 and 40"))
            return rep

    repo, _, first = go_web(tmp_path, ScriptedTeam(WEB))
    assert all(r.status in ("merged", "passed") for r in first.values())
    stack = NextSupabaseStack()
    stack.integration = False
    eng = Engine(repo, EditsOldMigration(WEB), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    change, results = change_project(1, "Keep pet names to 40 characters.", "A booking site", repo, eng,
                                     stack=stack, parallel=3)
    res = {r.task: r for r in results}
    assert {k: r.status for k, r in res.items()} == {"C1PLAN": "merged", "C1T1-qa": "passed", "C1T1": "merged"}, \
        {k: [(a.reason, a.test_output[-500:]) for a in r.attempts] for k, r in res.items()}
    assert "never edit an existing migration" in res["C1PLAN"].attempts[0].reason
    assert "Failed Tests 1 " in res["C1T1-qa"].attempts[0].test_output         # the 40-char rule; the rest pass
    tracked = git(repo, "ls-tree", "-r", "--name-only", "main").split()
    assert "supabase/migrations/0002_pet_name_40.sql" in tracked
    assert "between 1 and 60" in git(repo, "show", "main:supabase/migrations/0001_bookings.sql")
    assert "petName.length > 40" in git(repo, "show", "main:src/server/bookings.ts")
    plan = json.loads(git(repo, "show", "main:plan.json"))
    assert "supabase/migrations/0002_pet_name_40.sql" in plan["contracts"] and plan["tasks"][1]["spec"] == change["tasks"][0]["spec"]


def test_old_web_projects_get_current_template_files_but_keep_their_pages(tmp_path):
    """Regression (first live preview): Pawfect predated the template's serverless fix, so every page failed on
    Vercel and no agent may edit template files. Continuing a project now updates them in one commit."""
    from engine.stacks import NextSupabaseStack, upgrade_template
    stack = NextSupabaseStack(link_node_modules=False)
    repo = build_project_repo(tmp_path / "r", stack)
    (repo / "next.config.ts").write_text("export default {};\n")              # the old config
    (repo / "src/app/page.tsx").write_text("export default function Home() { return <p>ours</p>; }\n")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "old project")
    before = git(repo, "rev-parse", "HEAD").strip()
    assert upgrade_template(repo, stack) == ["next.config.ts"]
    assert "outputFileTracingIncludes" in (repo / "next.config.ts").read_text()
    assert "ours" in (repo / "src/app/page.tsx").read_text()                  # the project's pages stay
    assert git(repo, "rev-parse", "HEAD~1").strip() == before                  # exactly one new commit
    assert upgrade_template(repo, stack) == []                                 # nothing to do the second time
    assert default_stack().template_files() == {}
