"""The PM role, first slice (docs/pm.md): priorities in the plan, features saved for later, the ship gate, retro notes."""
import copy
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from engine.agents.scripted import ScriptedTeam
from engine.engine import Attempt, Engine, Result
from engine.events import Emitter, ListSink
from engine.interfaces import AgentReport
from engine.pm import read_retro, retro_section, saved_ids, ship_ready, write_retro
from engine.project import (build_project_repo, change_planning_task, default_stack, integration_task, make_tech_lead,
                            plan_problems, resume_project, resume_tasks, run_project)
from engine.sandboxes.local_worktree import LocalWorktreeSandbox

ROOT = Path(__file__).parent.parent
FIXTURE = ROOT / "projects" / "tool_library"
DESCRIPTION = (FIXTURE / "description.md").read_text()
PLAN = json.loads((FIXTURE / "plan" / "plan.json").read_text())
WEB_PLAN = json.loads((ROOT / "projects" / "web_bookings" / "plan" / "plan.json").read_text())
PRIORITY = {"T1": "must", "T2": "should", "T3": "could"}


def prioritized(plan, priorities=PRIORITY):
    p = copy.deepcopy(plan)
    for t in p["tasks"]:
        t["priority"], t["stories"] = priorities[t["id"]], [f"S{t['id'][1:]}"]
    return p


def sh(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


class Prioritized(ScriptedTeam):
    """The tool library's planner, with priorities: T1 must, T2 should, T3 could (T3 depends on T1 and T2)."""
    priorities = PRIORITY

    def __init__(self, fixture=FIXTURE, priorities=None):
        super().__init__(fixture)
        self.priorities = priorities or self.priorities
        self.calls = []

    def run(self, task, box, attempt, feedback):
        self.calls.append(task.id)
        rep = super().run(task, box, attempt, feedback)
        if task.role == "planner":
            box.write_file("plan.json", json.dumps(prioritized(PLAN, self.priorities), indent=2))
        return rep


def go(tmp_path, team, **kw):
    sink = ListSink()
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, team, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable, **kw)
    return repo, plan, {r.task: r for r in results}, sink.events


# --------------------------------------------------------------------------- priorities in the plan
def test_priorities_are_optional_and_old_plans_still_pass():
    assert plan_problems(PLAN) == []                                         # no priorities: all "must"
    assert plan_problems(prioritized(PLAN)) == []                            # could -> should/must is fine


@pytest.mark.parametrize("edit,msg", [
    (lambda p: p["tasks"][0].update(priority="Must!"), 'T1: "priority" must be "must", "should" or "could"'),
    (lambda p: p["tasks"][0].update(stories="S1"), 'T1: "stories" must be a list of story ids'),
    (lambda p: p["tasks"][2].update(priority="must"),
     'T3 ("must") depends on T2 ("should"): a task may only depend on tasks of the same or a higher priority; '
     'give T2 priority "must" or drop the dependency'),
    (lambda p: p["tasks"][2].update(priority="should"), None),          # the same priority: fine
    (lambda p: p["tasks"][2].pop("priority"), 'T3 ("must") depends on T2 ("should")'),   # missing means "must"
])
def test_plan_check_refuses_a_dependency_on_lower_priority(edit, msg):
    plan = prioritized(PLAN)
    edit(plan)
    problems = plan_problems(plan)
    if msg is None:
        assert problems == []
    else:
        assert any(msg in p for p in problems), problems


def test_should_may_not_depend_on_could():
    plan = prioritized(PLAN, {"T1": "could", "T2": "should", "T3": "should"})
    assert plan_problems(plan) == ['T3 ("should") depends on T1 ("could"): a task may only depend on tasks of the '
                                   'same or a higher priority; give T1 priority "should" or drop the dependency']


def test_plan_guide_asks_for_stories_and_priorities():
    from engine.project import planning_task
    spec = planning_task("x", default_stack()).spec
    assert '"stories": ["S1"], "priority": "must"' in spec and "same or a higher priority" in spec


def test_saved_ids_never_saves_a_must_and_takes_dependents_along():
    plan = prioritized(PLAN)
    assert saved_ids(plan, ["T3"]) == ["T3"]
    assert saved_ids(plan, ["T2"]) == ["T2", "T3"]                # T3 depends on T2: it could only end blocked
    assert saved_ids(plan, ["T1", "nope"]) == []                  # Musts are never saved for later
    assert saved_ids(PLAN, ["T3"]) == []                          # an old plan: everything is a Must
    assert saved_ids(plan, None) == []


# --------------------------------------------------------------------------- saved for later: new builds
def test_saved_features_are_not_built_and_the_build_is_done(tmp_path):
    team = Prioritized()
    asked = []
    repo, plan, res, events = go(tmp_path, team, deferred=lambda p: asked.append(p["tasks"][2]["priority"]) or ["T3"])
    assert asked == ["could"]                                     # read after approval, with the approved plan
    assert {k: r.status for k, r in res.items()} == {
        "PLAN": "merged", "T1-qa": "passed", "T2-qa": "passed", "T1": "merged", "T2": "merged"}
    assert not [c for c in team.calls if c.startswith("T3")]
    kinds = [e.kind for e in events]
    assert kinds.index("plan_decision") < kinds.index("pm_deferred") < kinds.index("task_queued", kinds.index("plan_decision"))
    assert [e.data for e in events if e.kind == "pm_deferred"] == [{"tasks": ["T3"], "titles": ["Overdue report"]}]
    from worker import finished
    assert finished(list(res.values()), ["T3"]) == "done"
    ready = ship_ready(plan, list(res.values()), needs_int=False)
    assert ready == {"saved": ["T3"], "musts": 1}


def test_nothing_saved_means_no_event_and_a_must_is_never_skipped(tmp_path):
    _, _, res, events = go(tmp_path, Prioritized(priorities={"T1": "must", "T2": "must", "T3": "must"}),
                           deferred=["T3", "T1"])
    assert {"T1", "T2", "T3"} <= set(res) and all(r.status in ("merged", "passed") for r in res.values())
    assert not [e for e in events if e.kind == "pm_deferred"]


def test_a_retry_skips_saved_features_and_build_saved_builds_them(tmp_path):
    repo, plan, res, _ = go(tmp_path, Prioritized(), deferred=["T3"])
    merged = {t for t, r in res.items() if r.status == "merged"}
    sink = ListSink()
    team = Prioritized()
    eng = Engine(repo, team, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    # Retry what failed with T3 still saved: nothing to do, and the app hears it is still saved
    assert resume_project(plan, DESCRIPTION, repo, eng, merged, stack=default_stack(sys.executable),
                          deferred=["T3"]) == []
    assert [e.data for e in sink.events if e.kind == "pm_deferred"] == [{"tasks": ["T3"], "titles": ["Overdue report"]}]
    # Build saved features: the app clears the list; T3 is built now, on top of the merged work
    sink.events.clear()
    again = {r.task: r.status for r in resume_project(plan, DESCRIPTION, repo, eng, merged,
                                                     stack=default_stack(sys.executable), deferred=[])}
    assert again == {"T3-qa": "passed", "T3": "merged"}
    assert not [e for e in sink.events if e.kind == "pm_deferred"]


def test_resume_tasks_skip_saved_qa_and_dev(tmp_path):
    todo = [t.id for t in resume_tasks(prioritized(PLAN), DESCRIPTION, default_stack(sys.executable), {"PLAN"},
                                       deferred=["T2"])]
    assert todo == ["T1-qa", "T1"]                                # T2 saved, and T3 depends on it


# --------------------------------------------------------------------------- saved for later: the integrator
def web_stack():
    from engine.stacks import NextSupabaseStack
    return NextSupabaseStack(link_node_modules=False)


def test_the_integrator_is_told_which_features_are_saved_and_never_waits_for_them():
    plan = prioritized(WEB_PLAN, {"T1": "must", "T2": "should", "T3": "could"})
    t = integration_task(plan, "A booking site", web_stack(), deferred=["T3"])
    assert t.depends_on == ["T1", "T2"] and t.waits_for == []
    assert "Saved for later" in t.spec and "- src/components/SlotPicker.tsx: Slot picker" in t.spec
    assert "never import or call them" in t.spec
    built = t.spec.split("Built and tested modules")[1].split("Saved for later")[0]
    assert "SlotPicker" not in built and "src/server/bookings.ts" in built
    plain = integration_task(plan, "A booking site", web_stack())
    assert "Saved for later" not in plain.spec and plain.waits_for == ["T3"]


def test_build_saved_on_a_web_app_integrates_again(tmp_path):
    plan = prioritized(WEB_PLAN, {"T1": "must", "T2": "should", "T3": "could"})
    merged = {"PLAN", "T1", "T2", "INT"}
    # still saved: nothing to do (the integration merged already)
    assert resume_tasks(plan, "x", web_stack(), merged, deferred=["T3"]) == []
    # Build saved features: T3 is built and the integrator wires it in
    todo = {t.id: t for t in resume_tasks(plan, "x", web_stack(), merged, deferred=[])}
    assert list(todo) == ["T3-qa", "T3", "INT"]
    assert todo["INT"].waits_for == ["T3"] and todo["INT"].depends_on == []
    assert "Saved for later" not in todo["INT"].spec


# --------------------------------------------------------------------------- finished() and the ship gate
def r(task, status, attempts=(), error=""):
    return Result(task, task, status, list(attempts), error)


def test_finished_counts_saved_features_as_not_failures():
    from worker import finished
    assert finished([r("T1", "merged"), r("T3", "blocked")], deferred=["T3"]) == "done"
    assert finished([r("T1", "merged"), r("T3-qa", "failed")], deferred=["T3"]) == "done"
    assert finished([r("T1", "merged"), r("T3", "blocked")]) == "failed"
    assert finished([r("T1", "failed"), r("T3", "blocked")], deferred=["T3"]) == "failed"


def test_ready_to_ship_rules():
    plan = prioritized(WEB_PLAN, {"T1": "must", "T2": "should", "T3": "could"})
    ok = [r("T1", "merged"), r("T2", "failed"), r("INT", "merged")]
    assert ship_ready(plan, ok) == {"saved": ["T2", "T3"], "musts": 1}       # failed Shoulds never block shipping
    assert ship_ready(plan, [r("T1", "failed"), r("INT", "merged")]) is None   # a Must failed
    assert ship_ready(plan, [r("T1", "merged"), r("INT", "failed")]) is None   # not integrated
    assert ship_ready(plan, [r("T1", "merged")], needs_int=False) == {"saved": ["T2", "T3"], "musts": 1}
    assert ship_ready(plan, [r("T3", "merged")], merged_before={"T1", "T2", "INT"}) == {"saved": [], "musts": 1}
    assert ship_ready(plan, [r("C1T1", "failed"), r("INT", "merged")], merged_before={"T1"}) is None  # a change task
    assert ship_ready(plan, [r("T1-qa", "failed")], merged_before={"T1", "INT"}) == {"saved": ["T2", "T3"], "musts": 1}
    assert ship_ready(WEB_PLAN, [], merged_before={"T1", "T2", "T3", "INT"}) == {"saved": [], "musts": 3}
    assert ship_ready(None, ok) is None


# --------------------------------------------------------------------------- retro notes
WHEN = datetime(2026, 11, 4, 15, 30, tzinfo=timezone.utc)


def attempt(n, passed, reason="", cost=0.1):
    return Attempt(n, "done", passed, reason, [], "", 1.0, cost, 3)


def run_results():
    return [r("PLAN", "merged", [attempt(1, True)]),
            r("T1", "merged", [attempt(1, False, "acceptance tests failed: 2 of 5"), attempt(2, True)]),
            r("T2", "failed", [attempt(n, False, "acceptance tests failed: 1 of 4") for n in (1, 2, 3)],
              error="Needs you: Should late fees stop at $50?"),
            r("T2-qa", "passed", [attempt(1, True)])]


def test_retro_section_records_what_failed_why_and_what_was_saved():
    section, summary = retro_section("Build finished", run_results(), prioritized(PLAN), deferred=["T3"],
                                     cost_usd=0.734, when=WHEN)
    assert section.startswith("## 2026-11-04 15:30 UTC · Build finished\n")
    assert "- Merged: 1 of 2 tasks" in section
    assert ("  - Late fees (T2): failed. acceptance tests failed: 1 of 4. Needs you: Should late fees stop at $50?"
            in section)
    assert "  - Lend and return tools (T1): 2 tries. acceptance tests failed: 2 of 5" in section
    assert "  - Late fees (T2): 3 tries." in section
    assert "- Saved for later: Overdue report" in section and "- Cost of this run: $0.73" in section
    assert summary == ("Build finished: 1 of 2 tasks merged. Didn't finish: Late fees (acceptance tests failed: 1 of 4. "
                       "Needs you: Should late fees stop at $50?). 2 tasks took more than one try. Saved for later: "
                       "Overdue report. Cost $0.73.")
    many = [r(f"T{i}", "failed", [attempt(1, False, "x" * 400)]) for i in range(10)]
    assert len(retro_section("Retry finished", many, None, cost_usd=0)[1]) <= 600


@pytest.fixture
def repos(tmp_path):
    bare, work = tmp_path / "remote.git", tmp_path / "work"
    sh(["init", "-q", "--bare", "-b", "main", str(bare)], tmp_path)
    sh(["init", "-q", "-b", "main", str(work)], tmp_path)
    (work / "plan.json").write_text("{}")
    sh(["add", "plan.json"], work)
    sh(["commit", "-qm", "init"], work)
    sh(["remote", "add", "origin", str(bare)], work)
    sh(["push", "-q", "-u", "origin", "main"], work)
    return work, bare


def test_write_retro_appends_commits_and_pushes(repos):
    work, bare = repos
    sink = ListSink()
    s1 = write_retro(work, "Build finished", run_results(), Emitter(sink), plan=PLAN, cost_usd=0.5, when=WHEN)
    s2 = write_retro(work, "Retry finished", [r("T2", "merged", [attempt(1, True)])], Emitter(sink), plan=PLAN,
                     cost_usd=0.1, when=WHEN)
    assert [(e.kind, e.data) for e in sink.events] == [("retro_written", {"summary": s1}),
                                                       ("retro_written", {"summary": s2})]
    text = sh(["show", "main:docs/retro.md"], bare)
    assert text.startswith("# Retro notes") and text.count("## 2026-11-04") == 2
    assert text.index("Build finished") < text.index("Retry finished")
    assert sh(["log", "-2", "--format=%s", "main"], bare).splitlines() == ["Retro: Retry finished", "Retro: Build finished"]
    assert sh(["status", "--porcelain"], work) == ""


def test_a_retro_that_cannot_be_pushed_never_fails_the_run_and_leaves_the_clone_as_it_was(repos, tmp_path):
    work, _ = repos
    before = sh(["rev-parse", "main"], work)
    sh(["remote", "set-url", "origin", str(tmp_path / "gone.git")], work)
    sink = ListSink()
    assert write_retro(work, "Build finished", run_results(), Emitter(sink)) is None
    assert sink.events == [] and sh(["rev-parse", "main"], work) == before
    assert not (work / "docs" / "retro.md").exists()
    assert write_retro(tmp_path / "not-a-repo", "Build finished", [], Emitter(sink)) is None and sink.events == []


def test_read_retro_returns_the_end_in_whole_lines(tmp_path):
    assert read_retro(tmp_path) == ""
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "retro.md").write_text("".join(f"line {i:04d} " + "x" * 40 + "\n" for i in range(200)))
    got = read_retro(tmp_path)
    assert len(got) <= 2000 and got.endswith("line 0199 " + "x" * 40) and got.startswith("line ")


def test_the_change_planner_and_the_tech_lead_read_the_retro(tmp_path):
    spec = change_planning_task(1, "Add renewals", PLAN, default_stack(), "x", retro="T2 failed: tests").spec
    assert "Notes from earlier runs (retro), the end of docs/retro.md:\nT2 failed: tests" in spec
    assert "Notes from earlier runs" not in change_planning_task(1, "Add renewals", PLAN, default_stack(), "x").spec

    seen = []

    class FakeEngine:
        def run_task(self, task):
            seen.append(task.spec)
            return Result(task.id, task.title, "error", [], "no sandbox")

    t = PLAN["tasks"][1]
    make_tech_lead(t, "acceptance/test_fees.py", {}, "models.py", FakeEngine(), object(), retro="T2 failed: tests")([], "")
    make_tech_lead(t, "acceptance/test_fees.py", {}, "models.py", FakeEngine(), object())([], "")
    assert "Notes from earlier runs (retro), the end of docs/retro.md:\nT2 failed: tests" in seen[0]
    assert "Notes from earlier runs" not in seen[1]


class NeverFixesT2(ScriptedTeam):
    def run(self, task, box, attempt, feedback):
        rep = super().run(task, box, attempt, feedback)
        if task.id == "T2":
            box.write_file("fees.py", "def late_fee_cents(loan, tool, today):\n    return 1\n")
        return rep


class Lead:
    model = "sonnet"

    def __init__(self):
        self.specs = []

    def run(self, task, box, attempt, feedback):
        self.specs.append(task.spec)
        box.write_file("review/T2-techlead.json", json.dumps({"decision": "escalate", "question": "Cap at $50?"}))
        return AgentReport("done")


def test_a_retry_s_tech_lead_reads_the_retro_from_the_repo(tmp_path):
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, NeverFixesT2(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    assert write_retro(repo, "Build finished", results, Emitter(), plan=plan, when=WHEN)
    lead = Lead()
    eng2 = Engine(repo, NeverFixesT2(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    again = {r.task: r for r in resume_project(plan, DESCRIPTION, repo, eng2, {"PLAN", "T1"},
                                               stack=default_stack(sys.executable), tech_lead=lead)}
    assert again["T2"].error == "Needs you: Cap at $50?" and len(lead.specs) == 1
    assert "Notes from earlier runs (retro)" in lead.specs[0] and "Late fees (T2): failed." in lead.specs[0]


# --------------------------------------------------------------------------- worker wiring
def test_worker_new_build_saves_features_writes_the_retro_and_says_ready_to_ship(tmp_path, monkeypatch):
    """worker.main for a new build, end to end without network: a bare repo stands in for GitHub, local worktrees
    for Daytona, the scripted team for Claude. The owner saves T3 for later on the approval screen."""
    import engine.agents.claude_cli
    import worker
    from engine.stacks import PythonStack
    bare = tmp_path / "remote.git"
    sh(["init", "-q", "--bare", "-b", "main", str(bare)], tmp_path)
    sent, reads = [], []

    class FakeBackend:
        def __init__(self, project_id):
            pass

        def project(self):
            reads.append(1)
            row = {"status": "starting" if len(reads) == 1 else "approved", "mode": None, "resume": False,
                   "change": None, "repo": None, "name": "Tool library", "model": "haiku", "description": DESCRIPTION,
                   "budgetUsd": 5.0, "costUsd": 0.0}
            return row if len(reads) == 1 else {**row, "deferred": ["T3", 7]}

        def write(self, e):
            sent.append((e.kind, e.data))

    class LocalEngine(Engine):
        def __init__(self, repo, agent, make_sandbox, **kw):
            super().__init__(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), **kw)

    team = Prioritized()

    class Stack(PythonStack):
        def __init__(self, **kw):
            super().__init__(sys.executable)

    monkeypatch.setattr(worker, "ConvexBackend", FakeBackend)
    monkeypatch.setattr(worker, "ROOT", tmp_path / "worker")
    monkeypatch.setattr(worker, "Engine", LocalEngine)
    monkeypatch.setattr(worker, "NextSupabaseStack", Stack)
    monkeypatch.setattr(worker, "create_repo", lambda name, token, description: str(bare))
    monkeypatch.setattr(engine.agents.claude_cli, "ClaudeCLIAgent", lambda **kw: team)
    for k in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "PROJECTS_GITHUB_TOKEN", "CONVEX_DEPLOY_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setattr(sys, "argv", ["worker.py", "--project-id", "p1"])
    worker.main()
    kinds = [k for k, _ in sent]
    assert ("pm_deferred", {"tasks": ["T3"], "titles": ["Overdue report"]}) in sent
    assert kinds.index("plan_decision") < kinds.index("pm_deferred")
    assert not [c for c in team.calls if c.startswith("T3")]
    assert kinds[-4:] == ["retro_written", "checkpoint_created", "project_finished", "ready_to_ship"]
    assert sent[-2][1]["status"] == "done"
    assert sent[-1][1] == {"saved": ["T3"], "musts": 1}
    summary = sent[-4][1]["summary"]
    assert summary == "Build finished: 2 of 2 tasks merged. Saved for later: Overdue report. Cost $0.00."
    retro = sh(["show", "main:docs/retro.md"], bare)
    assert "- Saved for later: Overdue report" in retro and "· Build finished" in retro
    # the checkpoint holds the retro: it was written first
    assert "docs/retro.md" in sh(["ls-tree", "-r", "--name-only", "checkpoint-1"], bare)
