"""The designer (docs/designer.md): screenshots of every page reviewed before the integration merges.
Scripted designers and a fake sandbox only: no model, no browser."""
import json
import subprocess
from pathlib import Path

import pytest

from benchmark.suite import HERE, build_repo, load_tasks
from engine.agents.scripted import ReferenceAgent, ScriptedTeam
from engine.budget import Budget
from engine.designer import (BUDGET_REASON, DESIGN_CHANGES, DESIGNER_ERROR_NOTE, design_brief, make_designer,
                             normalize_design_review, parse_design_review, review_design, screenshot_cmd,
                             take_screenshots)
from engine.engine import Engine
from engine.events import Emitter, ListSink
from engine.interfaces import AgentReport, ExecResult
from engine.sandboxes.local_worktree import LocalWorktreeSandbox

ROOT = Path(__file__).parent.parent
WEB = ROOT / "projects" / "web_bookings"


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


def kinds(sink, *names):
    return [(e.kind, e.task_id, e.data) for e in sink.events if e.kind in names]


def statuses(sink):
    return [e.data.get("status") for e in sink.events if e.kind == "task_status"]


class Dev(ReferenceAgent):
    """Writes the right solution on every try, except the tries listed in `broken` (they fail the checks)."""

    def __init__(self, broken=()):
        super().__init__(HERE / "solutions")
        self.seen, self.broken = [], set(broken)

    def run(self, task, box, attempt, feedback):
        self.seen.append((attempt, feedback))
        if attempt in self.broken:
            box.write_file("payments.py", "from store import *  # noqa\n\n# looks finished, isn't\n")
            return AgentReport("done")
        return super().run(task, box, attempt, feedback)


def design_task(verdicts, calls):
    """B6 with a scripted designer hook: one verdict per review, in order (an exception is raised instead). The hook
    sees the attempt's own sandbox, with the passing work already committed."""
    task = load_tasks(["B6"])[0]
    left = list(verdicts)

    def review(box, rnd, previous):
        committed = "NotImplementedError" not in box.exec("git show HEAD:payments.py").output
        calls.append((rnd, list(previous), committed, box.branch))
        box.write_file("review/INT-design.json", '{"verdict": "approve"}')   # never merged
        v = left.pop(0)
        if isinstance(v, Exception):
            raise v
        return v
    task.review_design = review
    return task


def make_engine(repo, agent, budget=None):
    sink = ListSink()
    return Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink),
                  budget=budget), sink


def designs(sink):
    return [d for _, _, d in kinds(sink, "design_review")]


# ------------------------------------------------------------------ the engine's hook
def test_an_approved_attempt_merges_after_the_design_review(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = make_engine(repo, Dev())
    r = eng.run_task(design_task([{"verdict": "approve", "comments": ["Calm and clear."]}], calls))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, True)]
    assert calls == [(1, [], True, "task/B6-a1")]           # in the attempt's own sandbox, after its work is committed
    assert designs(sink) == [{"verdict": "approve", "comments": ["Calm and clear."], "attempt": 1}]
    order = [(e.kind, e.data.get("status")) for e in sink.events
             if e.kind in ("task_status", "design_review", "attempt_finished")]
    assert order[order.index(("task_status", "checking")):] == [
        ("task_status", "checking"), ("task_status", "design_review"), ("design_review", None),
        ("attempt_finished", None), ("task_status", "merging"), ("task_status", "merged")]
    assert ("task_status", "B6", {"status": "design_review", "attempt": 1}) in kinds(sink, "task_status")
    assert "NotImplementedError" not in git(repo, "show", "main:payments.py")
    assert "review/" not in git(repo, "ls-tree", "-r", "--name-only", "main")     # screenshots and verdicts stay out


def test_changes_give_one_more_try_with_the_comments_then_an_approval_merges(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls, dev = [], Dev()
    comments = ["/book (390): the slot table runs off the right edge; let it wrap.",
                "/ (1280): the heading overlaps the nav bar; give the header its own row."]
    eng, sink = make_engine(repo, dev)
    r = eng.run_task(design_task([{"verdict": "changes", "comments": comments},
                                  {"verdict": "approve", "comments": []}], calls))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, False), (2, True)]
    first = r.attempts[0]
    assert first.reason == DESIGN_CHANGES and all(c in first.test_output for c in comments)
    assert [(c[0], c[1]) for c in calls] == [(1, []), (2, comments)]     # the second look knows what it asked for
    fb = dev.seen[1][1]
    assert fb.startswith("Your previous attempt passed the whole-app check, but the designer")
    assert all(f"- {c}" in fb for c in comments)
    assert designs(sink) == [{"verdict": "changes", "comments": comments, "attempt": 1},
                             {"verdict": "approve", "comments": [], "attempt": 2}]
    assert statuses(sink).count("design_review") == 2 and statuses(sink)[-1] == "merged"
    assert git(repo, "log", "--format=%s", "-1", "main") == "merge B6\n"


def test_changes_twice_merges_anyway_with_the_comments_as_warnings(tmp_path):
    repo = build_repo(tmp_path / "r")
    eng, sink = make_engine(repo, Dev())
    second = ["/ (390): the menu still covers the heading."]
    r = eng.run_task(design_task([{"verdict": "changes", "comments": ["/ (390): the menu covers the heading."]},
                                  {"verdict": "changes", "comments": second}], []))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, False), (2, True)]
    assert designs(sink)[1] == {"verdict": "changes", "comments": second, "attempt": 2, "warnings": True}
    assert "NotImplementedError" not in git(repo, "show", "main:payments.py")


def test_changes_on_a_later_try_still_get_exactly_one_more(tmp_path):
    repo = build_repo(tmp_path / "r")
    eng, sink = make_engine(repo, Dev(broken={1}))
    r = eng.run_task(design_task([{"verdict": "changes", "comments": ["x (390): cut off."]},
                                  {"verdict": "approve", "comments": []}], []))
    assert r.status == "merged" and [a.n for a in r.attempts] == [1, 2, 3]
    assert [d["attempt"] for d in designs(sink)] == [2, 3]


def test_a_fix_that_fails_its_checks_merges_the_reviewed_try_with_warnings(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls, dev = [], Dev(broken={2})
    comments = ["/ (390): the footer overlaps the form."]
    eng, sink = make_engine(repo, dev)
    r = eng.run_task(design_task([{"verdict": "changes", "comments": comments}], calls))
    assert r.status == "merged" and r.error == ""
    assert [(a.n, a.passed) for a in r.attempts] == [(1, False), (2, False)]       # exactly one more try, no third
    assert len(calls) == 1
    last = designs(sink)[-1]
    assert last["verdict"] == "changes" and last["warnings"] is True and last["comments"] == comments
    assert last["attempt"] == 1 and "try 2" in last["reason"] and "whole-app check" in last["reason"]
    assert "NotImplementedError" not in git(repo, "show", "main:payments.py")        # try 1's work is on main


def test_the_spending_limit_after_changes_still_merges_the_reviewed_try(tmp_path):
    class Costly(Dev):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            rep.cost_usd = 0.6
            return rep
    repo = build_repo(tmp_path / "r")
    eng, sink = make_engine(repo, Costly(), budget=Budget(1.0))
    task = design_task([{"verdict": "changes", "comments": ["/ (390): cut off."], "cost_usd": 0.5}], [])
    r = eng.run_task(task)
    assert r.status == "merged" and len(r.attempts) == 1
    assert designs(sink)[-1]["warnings"] is True and "spending limit" in designs(sink)[-1]["reason"]


@pytest.mark.parametrize("verdict", [RuntimeError("API Error: 529 overloaded"), None, "approve", {"verdict": "maybe"},
                                     {"verdict": "changes", "comments": []},
                                     {"designer_error": True, "note": "no valid verdict file"}])
def test_a_broken_design_review_approves_with_designer_error(tmp_path, verdict):
    repo = build_repo(tmp_path / "r")
    eng, sink = make_engine(repo, Dev())
    r = eng.run_task(design_task([verdict], []))
    assert r.status == "merged" and len(r.attempts) == 1 and r.attempts[0].passed
    d = designs(sink)[0]
    assert d["verdict"] == "approve" and d["designer_error"] is True and d["comments"] == [] and d["attempt"] == 1
    assert d["reason"].startswith(DESIGNER_ERROR_NOTE)


def test_no_design_review_when_the_budget_is_spent(tmp_path):
    class Costly(Dev):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            rep.cost_usd = 1.0
            return rep
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = make_engine(repo, Costly(), budget=Budget(1.0))
    r = eng.run_task(design_task([{"verdict": "changes", "comments": ["x"]}], calls))
    assert r.status == "merged" and calls == []
    assert designs(sink) == [{"verdict": "approve", "comments": [], "skipped": True, "reason": BUDGET_REASON,
                              "attempt": 1}]
    assert "design_review" not in statuses(sink)


def test_screenshots_that_fail_skip_the_review_with_a_reason(tmp_path):
    repo = build_repo(tmp_path / "r")
    eng, sink = make_engine(repo, Dev())
    reason = "no browser for screenshots: No browser for screenshots: Chromium couldn't start"
    r = eng.run_task(design_task([{"verdict": "approve", "comments": [], "skipped": True, "reason": reason}], []))
    assert r.status == "merged"
    assert designs(sink) == [{"verdict": "approve", "comments": [], "skipped": True, "reason": reason, "attempt": 1}]


def test_the_designers_cost_counts_but_never_as_a_try(tmp_path):
    repo = build_repo(tmp_path / "r")
    budget = Budget(5.0)
    eng, sink = make_engine(repo, Dev(), budget=budget)
    r = eng.run_task(design_task([{"verdict": "approve", "comments": [], "cost_usd": 0.12, "turns": 7,
                                   "seconds": 30.0, "claim": "done"}], []))
    assert r.status == "merged" and len(r.attempts) == 1 and budget.spent == pytest.approx(0.12)
    cost = [(t, d) for k, t, d in kinds(sink, "attempt_finished") if t == "B6-design"]
    assert cost == [("B6-design", {"n": 1, "passed": True, "claim": "done", "reason": "", "cost_usd": 0.12,
                                   "seconds": 30.0, "turns": 7, "files_changed": [], "output": ""})]


def test_failing_attempts_and_tasks_without_the_hook_are_never_designed(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = make_engine(repo, Dev(broken={1, 2, 3}))
    r = eng.run_task(design_task([], calls))
    assert r.status == "failed" and len(r.attempts) == 3 and calls == []
    eng2, sink2 = make_engine(build_repo(tmp_path / "r2"), Dev())
    assert eng2.run_task(load_tasks(["B6"])[0]).status == "merged"
    assert not designs(sink) and not designs(sink2)


# ------------------------------------------------------------------ only the integrator gets the hook
def test_only_the_integration_gets_the_designer(tmp_path):
    from engine.project import integration_task, resume_tasks, tasks_from_change, tasks_from_plan
    from engine.quick import quick_task
    from engine.stacks import NextSupabaseStack
    eng = Engine(tmp_path, ScriptedTeam(WEB), lambda t, n: None)
    plan = json.loads((WEB / "plan" / "plan.json").read_text())
    stack = NextSupabaseStack(link_node_modules=False)
    designer = object()
    todo = resume_tasks(plan, "x", stack, set(), engine=eng, designer=designer, reviewer=object())
    assert [t.id for t in todo if t.review_design] == ["INT"]
    assert all(t.review_design is None for t in tasks_from_plan(plan, stack, engine=eng))
    assert integration_task(plan, "x", stack).review_design is None                      # no designer: as before
    assert "a designer looks at screenshots" not in integration_task(plan, "x", stack).spec
    assert "390 px wide phone" in integration_task(plan, "x", stack, designer=designer).spec
    assert quick_task(1, "Make the heading green", plan, stack).review_design is None
    change = {"summary": "s", "contracts": [], "tasks": [dict(plan["tasks"][0], kind="change")]}
    assert all(t.review_design is None for t in tasks_from_change(change, plan, stack, engine=eng))


def test_worker_builds_a_sonnet_designer():
    from worker import designer_agent
    d = designer_agent(0.5)
    assert d.model == "sonnet" and d.budget_usd == 0.5 and d is not designer_agent(0.5)


# ------------------------------------------------------------------ screenshots and the designer's run
class FakeBox:
    """A sandbox that answers the screenshot script and cat with scripted results."""
    branch, workdir = "task/INT-a1", "/repo"

    def __init__(self, shot_code=0, shot_output="4 screenshots", manifest=None):
        self.files, self.cmds = {}, []
        self.shot_code, self.shot_output = shot_code, shot_output
        self.manifest = manifest if manifest is not None else {
            "shots": [{"route": "/", "width": 1280, "height": 800, "file": "review/screens/home-1280.png",
                       "title": "Petly"},
                      {"route": "/", "width": 390, "height": 844, "file": "review/screens/home-390.png",
                       "horizontal_scroll": True},
                      {"route": "/book", "width": 390, "height": 844, "file": "review/screens/book-390.png",
                       "cut": True}],
            "skipped": [{"route": "/my-pets", "reason": "a signed-out visitor is sent to /sign-in"}]}

    def exec(self, cmd, timeout=600, env=None):
        self.cmds.append((cmd, timeout))
        if cmd.startswith("node scripts/screenshots.mjs"):
            if self.shot_code == 0:
                self.files["review/screens/manifest.json"] = json.dumps(self.manifest)
            return ExecResult(self.shot_code, self.shot_output)
        if cmd.startswith("cat "):
            path = cmd.split()[1]
            return ExecResult(0, self.files[path]) if path in self.files else ExecResult(1, "")
        if cmd.startswith("rm -f "):
            self.files.pop(cmd.split()[2], None)
            return ExecResult(0, "")
        return ExecResult(0, "")

    def write_file(self, path, content):
        self.files[path] = content


class Designer:
    """Writes the verdict it's given (a string: the file's text; None: nothing) and remembers what it was told."""
    model = "sonnet"
    budget_usd = 0.75

    def __init__(self, verdict, claim="done", cost=0.08):
        self.verdict, self.claim, self.cost, self.tasks, self.caps = verdict, claim, cost, [], []

    def run(self, task, box, attempt, feedback, budget_cap=None):
        self.tasks.append(task)
        self.caps.append(budget_cap)
        if self.verdict is not None:
            box.write_file("review/INT-design.json", self.verdict)
        return AgentReport(self.claim, cost_usd=self.cost, turns=5)


BRIEF = "## Pages\n- P1 / Home: welcome visitors\n\n## Look and feel: Calm\nSoft greens."


def test_review_design_shows_the_designer_every_screenshot_and_reads_its_verdict():
    box, designer = FakeBox(), Designer('```json\n{"verdict": "changes", "comments": ["/ (390): scrolls sideways."]}\n```')
    v = review_design(box, designer, brief=BRIEF, routes=["/", "/book", "/owner-setup"], budget_cap=0.3)
    assert v == {"verdict": "changes", "comments": ["/ (390): scrolls sideways."], "cost_usd": 0.08, "turns": 5,
                 "claim": "done", "seconds": v["seconds"], "screens": 3}
    assert box.cmds[0] == ("node scripts/screenshots.mjs / /book /owner-setup 2>&1", 900)
    task = designer.tasks[0]
    assert task.role == "designer" and task.id == "INT-design" and task.can_edit == ["review/*"]
    for text in ("review/screens/home-1280.png", "review/screens/home-390.png (scrolls sideways)",
                 "review/screens/book-390.png (cut at 2400 px)", '"Petly"', "/my-pets: a signed-out visitor is sent",
                 "## Look and feel: Calm", "welcome visitors", "review/INT-design.json", "Never for taste"):
        assert text in task.spec, text
    assert designer.caps == [0.3]
    assert ("rm -f review/INT-design.json", 600) in box.cmds            # a stale verdict is never read


def test_review_design_second_round_lists_the_first_comments():
    designer = Designer('{"verdict": "approve"}')
    v = review_design(FakeBox(), designer, brief=BRIEF, rnd=2, previous=["/ (390): scrolls sideways."])
    assert v["verdict"] == "approve" and designer.tasks[0].id == "INT-design2"
    assert "second look" in designer.tasks[0].spec and "- / (390): scrolls sideways." in designer.tasks[0].spec


@pytest.mark.parametrize("code,output,reason", [
    (3, "No browser for screenshots: Playwright didn't install", "no browser for screenshots: No browser"),
    (2, "The app isn't built: run `npx next build` first.", "the app isn't built"),
    (1, "setup: Chromium ready\nScreenshots failed: the app didn't start", "Screenshots failed: the app didn't start"),
    (124, "timed out after 900s", "the screenshots timed out"),
])
def test_screenshots_that_fail_skip_without_running_the_designer(code, output, reason):
    designer = Designer('{"verdict": "changes", "comments": ["x"]}')
    v = review_design(FakeBox(shot_code=code, shot_output=output), designer, brief=BRIEF)
    assert v["skipped"] is True and v["verdict"] == "approve" and reason in v["reason"]
    assert v["cost_usd"] == 0 and designer.tasks == []


def test_screenshots_with_no_pages_shot_are_skipped():
    v = take_screenshots(FakeBox(manifest={"shots": [], "skipped": []}))
    assert v["ok"] is False and v["reason"].startswith("the screenshots couldn't be taken")


@pytest.mark.parametrize("verdict,claim", [(None, "done"), ("not json", "done"), ('{"verdict": "changes"}', "done"),
                                           (None, "error: hit the per-task budget cap")])
def test_a_designer_without_a_usable_verdict_is_a_designer_error(verdict, claim):
    v = review_design(FakeBox(), Designer(verdict, claim=claim), brief=BRIEF)
    assert v["designer_error"] is True and v["verdict"] == "approve" and v["cost_usd"] == 0.08
    if claim.startswith("error"):
        assert "budget cap" in v["reason"]


def test_a_crashing_designer_is_a_designer_error():
    class Crashes(Designer):
        def run(self, task, box, attempt, feedback, budget_cap=None):
            raise RuntimeError("sandbox gone")
    v = review_design(FakeBox(), Crashes(None), brief=BRIEF)
    assert v["designer_error"] is True and "sandbox gone" in v["reason"]


def test_make_designer_caps_the_run_at_the_budget_left():
    designer = Designer('{"verdict": "approve"}')
    budget = Budget(1.0, already_spent_usd=0.9)
    hook = make_designer(designer, BRIEF, ["/"], budget=budget)
    assert hook(FakeBox(), 1, [])["verdict"] == "approve"
    assert designer.caps == [pytest.approx(0.1)]


def test_the_integrator_and_its_designer_end_to_end_in_a_sandbox(tmp_path):
    """The real hook (make_designer) inside the engine, on a local sandbox whose screenshot script is a stand-in."""
    repo = build_repo(tmp_path / "r")
    script = ("mkdir -p review/screens && printf '{\"shots\": [{\"route\": \"/\", \"width\": 390, "
              "\"file\": \"review/screens/home-390.png\"}]}' > review/screens/manifest.json")
    task = load_tasks(["B6"])[0]
    designer = Designer('{"verdict": "changes", "comments": ["/ (390): the button is cut off."]}')
    hook = make_designer(designer, BRIEF)

    class Box(LocalWorktreeSandbox):
        def exec(self, cmd, timeout=600, env=None):
            return super().exec(script if cmd.startswith("node scripts/screenshots.mjs") else cmd, timeout, env)
    sink = ListSink()
    eng = Engine(repo, Dev(), lambda t, n: Box(repo, t.id, n), events=Emitter(sink))
    task.review_design = hook
    r = eng.run_task(task)
    assert r.status == "merged" and [a.passed for a in r.attempts] == [False, True]
    assert designs(sink)[-1]["warnings"] is True
    assert "review/" not in git(repo, "ls-tree", "-r", "--name-only", "main")


# ------------------------------------------------------------------ pure helpers
def test_design_brief_keeps_the_pages_and_the_look():
    spec = ("# Petly\n\nA vet clinic.\n\n## Decisions\n- x\n\n## Pages\n- P1 / Home: welcome\n- P2 /book Book: pick a "
            "slot\n\n## Look and feel: Calm\nSoft.\nPalette: Leaf #3a7; font Inter; corners rounded.\n\nPlan tasks "
            "for every story.")
    brief = design_brief(spec)
    assert brief.startswith("## Pages\n- P1 / Home: welcome") and "## Look and feel: Calm" in brief
    assert "Palette: Leaf #3a7" in brief and "## Decisions" not in brief and "A vet clinic" not in brief
    assert design_brief("Just a plain description.") == "Just a plain description."
    assert len(design_brief("x" * 9000)) <= 4000


def test_screenshot_cmd_quotes_routes_and_ignores_anything_else():
    assert screenshot_cmd(["/", "/staff/schedule", "/a b", "rm -rf"]) == \
        "node scripts/screenshots.mjs / /staff/schedule '/a b'"


def test_parse_and_normalize_design_review():
    assert parse_design_review('{"verdict": "Approve"}') == {"verdict": "approve", "comments": []}
    assert parse_design_review('{"verdict": "changes", "comments": "one"}') == {"verdict": "changes",
                                                                                "comments": ["one"]}
    for bad in ("", "{", '{"verdict": "changes"}', '{"verdict": "skip"}', "[1]"):
        assert parse_design_review(bad) is None, bad
    many = normalize_design_review({"verdict": "approve", "comments": [f" n  {i}" for i in range(20)]})
    assert many["comments"][0] == "n 0" and len(many["comments"]) == 8
    assert normalize_design_review({"skipped": True, "reason": "no  browser"}) == {
        "verdict": "approve", "comments": [], "skipped": True, "reason": "no browser"}
    assert normalize_design_review({"verdict": "changes", "comments": [""]})["designer_error"] is True
    assert normalize_design_review(None)["designer_error"] is True


def test_the_template_ships_the_screenshot_script_and_it_is_reserved():
    from engine.stacks import NextSupabaseStack
    stack = NextSupabaseStack(link_node_modules=False)
    assert "scripts/screenshots.mjs" in stack.reserved
    assert "scripts/screenshots.mjs" in stack.template_files() or not (ROOT / ".git").exists()
    text = (ROOT / "templates" / "next-supabase" / "scripts" / "screenshots.mjs").read_text()
    for needed in ("width: 1280, height: 800", "width: 390, height: 844", "review/screens", "--with-deps chromium",
                   "manifest.json", "delete env.DATABASE_URL"):
        assert needed in text, needed


def test_the_designer_has_its_own_rules():
    from engine.agents.prompt import system_rules
    from engine.interfaces import Task
    rules = system_rules(Task("INT-design", "Design review", "", ["review/*"], "", role="designer"))
    assert rules.startswith("You are the designer") and "Never for taste" in rules

