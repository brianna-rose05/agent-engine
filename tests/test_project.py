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
from engine.project import build_project_repo, plan_problems, run_project, summary_counts, tasks_from_plan
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
    assert all(r.status in ("merged", "passed") for r in results)


# ------------------------------------------------------- phase 1: Next.js + Supabase web apps
WEB = Path(__file__).parent.parent / "projects" / "web_bookings"
TEMPLATE_READY = (Path(__file__).parent.parent / "templates" / "next-supabase" / "node_modules").exists()
web = pytest.mark.skipif(not TEMPLATE_READY, reason="run `npm ci` in templates/next-supabase first")


def go_web(tmp_path, agent):
    from engine.stacks import NextSupabaseStack
    stack = NextSupabaseStack()
    repo = build_project_repo(tmp_path / "r", stack)
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    plan, results = run_project((WEB / "description.md").read_text(), repo, eng, stack=stack, parallel=3)
    return repo, plan, {r.task: r for r in results}


@web
def test_web_project_plans_tests_and_builds(tmp_path):
    repo, plan, res = go_web(tmp_path, ScriptedTeam(WEB))
    assert {k: r.status for k, r in res.items()} == {
        "PLAN": "merged", "T1-qa": "passed", "T2-qa": "passed", "T3-qa": "passed",
        "T1": "merged", "T2": "merged", "T3": "merged"}, {k: [a.reason for a in r.attempts] for k, r in res.items()}
    tracked = git(repo, "ls-tree", "-r", "--name-only", "main").split()
    assert "src/server/bookings.ts" in tracked and "node_modules" not in tracked
    assert not [f for f in tracked if f.startswith("tests/acceptance/")]          # hidden tests never merged


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
