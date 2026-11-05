"""The architect (docs/architect.md): reviews a plan's contracts after its checks pass and before the owner approves."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from engine.agents.scripted import ScriptedTeam
from engine.budget import Budget
from engine.engine import ARCHITECT_CHANGES, Engine, normalize_architect_review
from engine.events import Emitter, ListSink
from engine.interfaces import AgentReport
from engine.project import (auto_approve, build_project_repo, change_project, default_stack, exported_names,
                            run_project)
from engine.sandboxes.local_worktree import LocalWorktreeSandbox

FIXTURE = Path(__file__).parent.parent / "projects" / "tool_library"
DESCRIPTION = (FIXTURE / "description.md").read_text()
REQUEST = "One free day before late fees, please. And renewals!"
APPROVE = '{"verdict": "approve", "comments": []}'


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


class Architect:
    """Writes the verdict file for each review: `verdicts` is a list, one per review (the last one repeats)."""
    model = "sonnet"

    def __init__(self, *verdicts: str, crash: bool = False):
        self.verdicts, self.crash, self.seen = list(verdicts) or [APPROVE], crash, []

    def run(self, task, box, attempt, feedback):
        plan_id = task.id.split("-architect")[0]
        self.seen.append({"task": task, "status": box.exec("git status --short").output,
                          "plan": box.exec("cat plan.json").output})
        if self.crash:
            raise RuntimeError("the architect's CLI died")
        said = self.verdicts.pop(0) if len(self.verdicts) > 1 else self.verdicts[0]
        box.write_file(f"review/{plan_id}-architect.json", said)
        return AgentReport("done")


class Records(ScriptedTeam):
    """The scripted team, recording what each task was told."""
    def __init__(self, fixture, cost: float = 0.0):
        super().__init__(fixture)
        self.seen, self.cost = [], cost

    def run(self, task, box, attempt, feedback):
        self.seen.append((task.id, attempt, feedback))
        rep = super().run(task, box, attempt, feedback)
        return AgentReport(rep.claim, cost_usd=self.cost if task.role == "planner" else 0.0)


def go(tmp_path, team, architect, budget=None):
    sink = ListSink()
    repo = build_project_repo(tmp_path / "r")
    eng = Engine(repo, team, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink), budget=budget)
    approved = []
    plan, results = run_project(DESCRIPTION, repo, eng, python=sys.executable, architect=architect,
                                approve=lambda p: (approved.append(p), (True, "ok"))[1])
    return repo, plan, {r.task: r for r in results}, sink.events, approved


def reviews(events, tid="PLAN"):
    return [e.data for e in events if e.kind == "architect_review" and e.task_id == tid]


def test_an_approving_architect_lets_the_plan_through_unchanged(tmp_path):
    arch = Architect()
    repo, plan, res, events, approved = go(tmp_path, ScriptedTeam(FIXTURE), arch)
    assert res["PLAN"].status == "merged" and len(res["PLAN"].attempts) == 1 and approved == [plan]
    assert all(r.status in ("merged", "passed") for r in res.values())
    assert reviews(events) == [{"verdict": "approve", "comments": [], "round": 1}]
    (seen,) = arch.seen
    task = seen["task"]
    assert task.id == "PLAN-architect" and task.role == "architect" and not task.merge and task.max_attempts == 1
    assert "review/PLAN-architect.json" in task.spec and "new project" in task.spec
    # it sees the repo as the plan leaves it: main plus the planner's files, uncommitted
    assert json.loads(seen["plan"])["project"] == "Neighborhood tool library"
    assert "plan.json" in seen["status"] and "fees.py" in seen["status"]
    kinds = [(e.kind, e.task_id, e.data.get("status")) for e in events]
    assert kinds.index(("task_status", "PLAN", "architect_reviewing")) < kinds.index(("architect_review", "PLAN", None)) \
        < kinds.index(("plan_ready", None, None)) < kinds.index(("plan_decision", None, None))
    assert "review/" not in git(repo, "ls-tree", "-r", "--name-only", "main")       # nothing of it merged


def test_changes_send_the_plan_back_once_with_the_comments_then_approve(tmp_path):
    comment = "Security: loans.member_id has no ownership check in the contract; lending.py must check it."
    arch = Architect(json.dumps({"verdict": "changes", "comments": [comment]}), APPROVE)
    team = Records(FIXTURE)
    repo, plan, res, events, approved = go(tmp_path, team, arch)
    assert res["PLAN"].status == "merged" and approved == [plan]
    assert [(a.n, a.passed, a.reason) for a in res["PLAN"].attempts] == [(1, False, ARCHITECT_CHANGES), (2, True, "")]
    fb = next(f for tid, n, f in team.seen if tid == "PLAN" and n == 2)
    assert comment in fb and "architect" in fb and "write the whole plan again" in fb
    assert reviews(events) == [{"verdict": "changes", "comments": [comment], "round": 1},
                               {"verdict": "approve", "comments": [], "round": 2}]
    first, second = (s["task"] for s in arch.seen)
    assert (first.id, second.id) == ("PLAN-architect", "PLAN-architect2")
    assert "second review" not in first.spec and comment in second.spec and "second review" in second.spec
    plans = [e for e in events if e.kind == "plan_ready"]
    assert len(plans) == 1                                                  # the owner sees only the final plan
    assert git(repo, "log", "--merges", "--format=%s", "main").count("merge PLAN") == 1


def test_changes_twice_goes_to_the_owner_with_warnings(tmp_path):
    first = json.dumps({"verdict": "changes", "comments": ["0002_x.sql drops the members table."]})
    again = json.dumps({"verdict": "changes", "comments": ["Still drops members.", "And loans."]})
    arch = Architect(first, again)
    repo, plan, res, events, approved = go(tmp_path, ScriptedTeam(FIXTURE), arch)
    assert res["PLAN"].status == "merged" and approved == [plan] and len(arch.seen) == 2
    assert [a.passed for a in res["PLAN"].attempts] == [False, True]
    assert reviews(events)[1] == {"verdict": "changes", "comments": ["Still drops members.", "And loans."], "round": 2,
                                  "warnings": True}
    kinds = [e.kind for e in events]
    assert kinds.index("architect_review", kinds.index("architect_review") + 1) < kinds.index("plan_ready")
    assert all(r.status in ("merged", "passed") for r in res.values())     # the owner approved: it builds


@pytest.mark.parametrize("arch", [Architect(crash=True), Architect(""), Architect("not json"),
                                  Architect('{"verdict": "changes"}'), Architect('{"verdict": "later"}')])
def test_a_crashed_or_unusable_architect_approves_with_architect_error(tmp_path, arch):
    _, plan, res, events, approved = go(tmp_path, ScriptedTeam(FIXTURE), arch)
    assert res["PLAN"].status == "merged" and len(res["PLAN"].attempts) == 1 and approved == [plan]
    assert reviews(events) == [{"verdict": "approve", "comments": [], "round": 1, "architect_error": True}]


def test_the_architect_is_skipped_when_the_budget_does_not_allow_it(tmp_path):
    arch = Architect(json.dumps({"verdict": "changes", "comments": ["x"]}))
    _, plan, res, events, approved = go(tmp_path, Records(FIXTURE, cost=0.6), arch, budget=Budget(0.5))
    assert arch.seen == [] and res["PLAN"].status == "merged" and approved == [plan]
    assert reviews(events) == [{"verdict": "approve", "comments": [], "round": 1, "skipped": True}]
    assert not [e for e in events if e.kind == "task_status" and e.data.get("status") == "architect_reviewing"]


def test_without_an_architect_planning_is_as_before(tmp_path):
    _, _, res, events, _ = go(tmp_path, ScriptedTeam(FIXTURE), None)
    assert res["PLAN"].status == "merged" and not reviews(events)


def test_normalize_architect_review():
    assert normalize_architect_review({"verdict": "changes", "comments": ["  a  b ", "", 3]}) == {
        "verdict": "changes", "comments": ["a b", "3"]}
    assert normalize_architect_review({"verdict": "approve", "comments": "note"}) == {
        "verdict": "approve", "comments": ["note"]}
    assert len(normalize_architect_review({"verdict": "changes", "comments": ["c"] * 20})["comments"]) == 8
    for bad in (None, "x", {}, {"verdict": "changes"}, {"verdict": "changes", "comments": [" "]},
                {"architect_error": True}, {"verdict": "maybe"}):
        assert normalize_architect_review(bad) == {"verdict": "approve", "comments": [], "architect_error": True}


def test_exported_names():
    py = "import x\nfrom y import z\n\ndef late_fee_cents(a):\n    inner = 1\n    if a == 2:\n        pass\n" \
         "class Fee:\n    pass\nCAP: int = 5000\n_private = 1\nelse_ish = 2\n"
    assert exported_names("fees.py", py) == {"late_fee_cents", "Fee", "CAP", "else_ish"}
    ts = ("export async function requireAdmin(): Promise<void> {}\nexport const ROLES = [];\n"
          "export type Profile = {};\nexport interface P2 {}\nfunction local() {}\nexport { local as shown, other };\n"
          "export default function Page() {}\n")
    assert exported_names("src/server/profiles.ts", ts) == {"requireAdmin", "ROLES", "Profile", "P2", "shown", "other",
                                                           "Page"}
    assert exported_names("supabase/migrations/0002_x.sql", "create table x();") == set()


def test_worker_builds_a_sonnet_architect():
    from worker import architect_agent
    arch = architect_agent(0.5)
    assert arch.model == "sonnet" and arch.budget_usd == 0.5 and arch is not architect_agent(0.5)


# ------------------------------------------------------------------ change requests
@pytest.fixture(scope="module")
def built_repo(tmp_path_factory):
    base = tmp_path_factory.mktemp("built")
    repo = build_project_repo(base / "r")
    eng = Engine(repo, ScriptedTeam(FIXTURE), lambda t, n: LocalWorktreeSandbox(repo, t.id, n))
    _, results = run_project(DESCRIPTION, repo, eng, python=sys.executable)
    assert all(r.status in ("merged", "passed") for r in results)
    shutil.rmtree(base / "sandboxes", ignore_errors=True)
    git(repo, "worktree", "prune")
    return repo


RENAMED_FEES = '''def fee_cents(loan, tool, today):
    """Renamed from late_fee_cents (the old name is removed). Days late = (loan.returned, or today if not returned)
    minus loan.due, in days. The first day late is free: if days late is 1 or less the fee is 0. Otherwise
    (days late - 1) * tool.daily_fee_cents, capped at 5000."""
    late = ((loan.returned or today) - loan.due).days
    return 0 if late <= 0 else min(5000, late * tool.daily_fee_cents)
'''


class RemovesExportFirst(Records):
    """The change planner's first plan renames fees.late_fee_cents to fee_cents (the regression: a removed export
    that reports.py still calls); with the architect's comments it writes the fixture's plan, which keeps it."""
    def run(self, task, box, attempt, feedback):
        rep = super().run(task, box, attempt, feedback)
        if task.id == "C1PLAN" and attempt == 1:
            box.write_file("fees.py", RENAMED_FEES)
        return rep


class GrepsLikeTheSpecSays(Architect):
    """Follows the spec's grep step for the name the change removes, and asks for changes when it has users."""
    def run(self, task, box, attempt, feedback):
        assert 'git grep -n -w "<name>"' in task.spec
        hits = box.exec("git grep -n -w late_fee_cents -- . ':!changes/1.json' ':!plan.json'").output
        users = sorted({h.split(":", 1)[0] for h in hits.splitlines()} - {"fees.py"})
        removed = box.exec("grep -q 'def late_fee_cents' fees.py").code != 0
        self.verdicts = [json.dumps({"verdict": "changes", "comments": [
            f"fees.late_fee_cents is removed but still used by {', '.join(users)}; keep it as a thin wrapper."]})
                         if removed and users else APPROVE]
        return super().run(task, box, attempt, feedback)


def test_the_architect_finds_a_removed_export_that_is_still_used(tmp_path, built_repo):
    repo = tmp_path / "r"
    shutil.copytree(built_repo, repo, symlinks=True)
    sink = ListSink()
    team, arch = RemovesExportFirst(FIXTURE), GrepsLikeTheSpecSays()
    eng = Engine(repo, team, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    change, results = change_project(1, REQUEST, DESCRIPTION, repo, eng, approve=auto_approve,
                                     stack=default_stack(sys.executable), architect=arch)
    res = {r.task: r for r in results}
    events = sink.events
    assert [(a.passed, a.reason) for a in res["C1PLAN"].attempts] == [(False, ARCHITECT_CHANGES), (True, "")]
    first = reviews(events, "C1PLAN")[0]
    assert first["verdict"] == "changes" and "reports.py" in first["comments"][0] and first["round"] == 1
    assert reviews(events, "C1PLAN")[1] == {"verdict": "approve", "comments": [], "round": 2}
    spec = arch.seen[0]["task"].spec
    assert arch.seen[0]["task"].id == "C1PLAN-architect" and "review/C1PLAN-architect.json" in spec
    assert "One free day before late fees" in spec and "changes/1.json" in spec
    # the engine found the removed name itself, with its user on main
    assert "late_fee_cents (fees.py): reports.py:" in spec
    assert "destructive" in spec.lower() and "Security:" in spec
    fb = next(f for tid, n, f in team.seen if tid == "C1PLAN" and n == 2)
    assert "thin wrapper" in fb
    assert {k: r.status for k, r in res.items()}["C1T1"] == "merged"
    assert "def late_fee_cents" in git(repo, "show", "main:fees.py")
