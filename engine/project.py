"""Milestone 3: from a project description to merged, verified code with no human in the loop.

    1. PLAN    A planner agent writes plan.json, the shared contract, and a stub per task.
               The engine validates the plan itself (format, dependency graph, file ownership,
               stubs import) and sends it back with the reasons if anything is wrong.
    2. QA      For every task, in parallel, a QA agent writes acceptance tests from the spec.
               The engine accepts them only if they run cleanly and every test fails against
               the stub because it is unimplemented. They are never merged, so dev agents
               can't see them.
    3. BUILD   Dev agents implement the tasks in dependency order (milestone 2), each graded
               by the hidden tests its QA agent wrote.

Nobody's "done" is trusted: each stage is checked by the engine, not by the agent that did it.
"""
from __future__ import annotations

import ast
import copy
import json
import re
import shlex
import subprocess
from fnmatch import fnmatch
from pathlib import Path
from typing import Callable

from engine.engine import Engine, GraphError, Result, SetupError, check_graph, failure_excerpt, git
from engine.gitlock import repo_lock
from engine.interfaces import Sandbox, Task
from engine.pm import PRIORITIES, priority_problems, read_retro, retro_block, saved_ids, saved_note
from engine.stacks import PythonStack, plain

MAX_TASKS = 10
MIN_QA_TESTS = 3
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")

PLAN_GUIDE = """Plan this project so a team of AI agents can build it in parallel.

{layout}

plan.json, exactly this shape:
   {{"project": "<name>",
     "contracts": ["<contract file>", ...],
     "tasks": [{{"id": "T1", "title": "<short>", "module": "<the one file this task owns>",
                "spec": "<what to build, precise enough to test>", "depends_on": [],
                "stories": ["S1"], "priority": "must"}}]}}
   - 2 to {max_tasks} tasks. Ids are short (T1, T2...). Each task owns exactly one module and
     no module is shared. depends_on lists task ids whose code this task calls; no cycles.
   - Prefer tasks that can run in parallel. Only add a dependency when one task calls another's code.
   - "stories": the ids of the user stories the task serves (if the description has stories like S1).
     "priority": "must", "should" or "could", the highest priority among those stories (default "must").
     A UI component or page task gets the priority of the stories it shows.
   - A task may only depend on tasks of the same or a higher priority: a "must" task never depends on a
     "should" or "could" task, and a "should" task never depends on a "could" task.
   - Every file you create must be listed in plan.json as a contract or a task module.

Project description:
{description}"""


def default_stack(python: str = "python3") -> PythonStack:
    return PythonStack(python)


# ------------------------------------------------------------------- repo
def build_project_repo(dest: Path, stack: PythonStack | None = None) -> Path:
    """An empty project repo for the stack: team rules, test setup, and (for web apps) the template."""
    return (stack or default_stack()).build_repo(Path(dest))


# ------------------------------------------------------------------- plan
def plan_problems(plan, stack: PythonStack | None = None) -> list[str]:
    """Everything wrong with a plan's structure, in words a planner can act on."""
    stack = stack or default_stack()
    if not isinstance(plan, dict):
        return ["plan.json must be a JSON object"]
    p = []
    contracts, tasks = plan.get("contracts", []), plan.get("tasks")
    if not isinstance(plan.get("project"), str) or not plan["project"].strip():
        p.append('"project" must be a non-empty string')
    if not isinstance(contracts, list) or not all(isinstance(c, str) for c in contracts):
        return p + ['"contracts" must be a list of file names']
    if not isinstance(tasks, list) or not 2 <= len(tasks) <= MAX_TASKS:
        return p + [f'"tasks" must be a list of 2 to {MAX_TASKS} tasks']
    owners: dict[str, str] = {}
    for c in contracts:
        if not stack.contract_re.match(c) or c in stack.reserved:
            p.append(f"contract {c!r} must be {stack.contract_rule}")
        owners[c] = "contracts"
    for t in tasks:
        if not isinstance(t, dict):
            p.append("every task must be an object")
            continue
        tid = t.get("id")
        if not isinstance(tid, str) or not ID_RE.match(tid):
            p.append(f"task id {tid!r} must be short letters/digits, like T1")
            continue
        for key in ("title", "spec"):
            if not isinstance(t.get(key), str) or not t[key].strip():
                p.append(f"{tid}: {key!r} must be a non-empty string")
        mod = t.get("module")
        if not isinstance(mod, str) or not stack.module_re.match(mod) or mod in stack.reserved:
            p.append(f"{tid}: module {mod!r} must be {stack.module_rule}")
        elif mod in owners:
            p.append(f"{tid}: module {mod} is already owned by {owners[mod]}; each module has one owner")
        else:
            owners[mod] = tid
        deps = t.get("depends_on", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            p.append(f"{tid}: depends_on must be a list of task ids")
        if "priority" in t and t["priority"] not in PRIORITIES:
            p.append(f'{tid}: "priority" must be "must", "should" or "could"')
        stories = t.get("stories", [])
        if not isinstance(stories, list) or not all(isinstance(s, str) for s in stories):
            p.append(f'{tid}: "stories" must be a list of story ids, like ["S1"]')
    pages = plan.get("pages", [])
    if not isinstance(pages, list) or not all(isinstance(r, str) and re.match(r"^/[A-Za-z0-9_\-/]*$", r) for r in pages):
        p.append('"pages" must be a list of routes like "/book" (no dynamic segments)')
    if p:
        return p
    slugs = [stack.slug(t["module"]) for t in tasks]
    if len(set(slugs)) != len(slugs):
        p.append("two task modules would share a test file name; give them distinct names")
    try:
        check_graph([Task(t["id"], t["title"], "", [], "", depends_on=t.get("depends_on", [])) for t in tasks])
    except GraphError as e:
        p.append(str(e))
    return p + priority_problems(tasks)


def without(plan: dict, ids) -> dict:
    ids = set(ids)
    return dict(plan, tasks=[t for t in plan["tasks"] if t["id"] not in ids])


def plan_check(stack: PythonStack):
    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec("cat plan.json")
        if r.code:
            return False, "plan.json is missing", ""
        try:
            plan = json.loads(r.output)
        except json.JSONDecodeError as e:
            return False, f"plan.json is not valid JSON ({e})", ""
        # Template files the planner lists as contracts (e.g. the base migration) are already locked;
        # drop them instead of rejecting a good plan. Regression: the fourth web run lost its plan to this.
        if isinstance(plan, dict) and isinstance(plan.get("contracts"), list):
            plan["contracts"] = [c for c in plan["contracts"] if c not in stack.reserved]
            box.write_file("plan.json", json.dumps(plan, indent=2))
        if problems := plan_problems(plan, stack):
            return False, "the plan has problems: " + "; ".join(problems), ""
        changed = box.exec("git diff --name-only $(git merge-base HEAD main); "
                           "git ls-files --others --exclude-standard").output.split()
        if not stack.nested_files_ok and (nested := [f for f in changed if "/" in f]):
            return False, f"planning files must be top-level; remove {', '.join(nested)}", ""
        modules = [t["module"] for t in plan["tasks"]]
        expected = set(modules) | set(plan["contracts"]) | {"plan.json"}
        extra = sorted(set(changed) - expected)
        # Stray edits to files that already existed (template files) are undone rather than failing a good
        # plan; nothing in the plan depends on them. Regression: Pawfect rebuild lost a plan to src/app/page.tsx.
        existed = set(box.exec("git ls-tree -r --name-only $(git merge-base HEAD main)").output.split())
        if stray := [f for f in extra if f in existed]:
            box.exec("git checkout $(git merge-base HEAD main) -- " + " ".join(shlex.quote(f) for f in stray))
            extra = [f for f in extra if f not in existed]
        if extra:
            return False, f"files not named in plan.json: {', '.join(extra)}", ""
        if missing := [f for f in sorted(expected) if box.exec(f"test -f {shlex.quote(f)}").code]:
            return False, f"plan.json names files that don't exist: {', '.join(missing)}", ""
        chk = box.exec(stack.plan_check_cmd(plan["contracts"], modules), timeout=900)
        if stack.runner_missing(chk.code, chk.output):
            raise SetupError(f"the checks could not run in the sandbox: {chk.output[-300:]}")
        if chk.code:
            return False, "the contracts and stubs don't pass the checks (types, imports or migrations)", chk.output[-2000:]
        marker = shlex.quote(stack.stub_marker)
        if unstubbed := [m for m in modules if box.exec(f"grep -q {marker} {shlex.quote(m)}").code]:
            return False, f"task modules must be stubs ({stack.stub_marker}): {', '.join(unstubbed)}", ""
        return True, "", f"plan OK: {len(modules)} tasks"
    return check


def planning_task(description: str, stack: PythonStack) -> Task:
    return Task("PLAN", "Plan the project",
                PLAN_GUIDE.format(layout=stack.plan_layout, description=description.strip(), max_tasks=MAX_TASKS),
                ["*"], "", role="planner", check=plan_check(stack))


# --------------------------------------------------------------------- QA
def summary_counts(output: str) -> dict[str, int]:
    """pytest summary counts (kept for callers of the original Python-only API)."""
    tail = "\n".join(output.strip().splitlines()[-3:])
    return {k: int(n) for n, k in re.findall(r"(\d+) (passed|failed|errors?)", tail)}


def qa_check(test_path: str, stack: PythonStack, bucket: dict[str, str], mode: str = "new",
             state: dict | None = None, can_confirm: bool = False):
    """Tests are useful only if they run, and fail now because the code isn't written yet. For a change to
    working code (mode "change") tests of behavior that stays may pass, but at least one must fail: the change
    isn't made yet, so a suite that passes in full checks nothing new. The unimplemented-marker rule is for
    stubs only; a changed module is real code."""
    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec(stack.run_tests(shlex.quote(test_path)), timeout=900)
        tail = "\n".join(r.output.strip().splitlines()[-25:])
        if stack.runner_missing(r.code, r.output):
            raise SetupError(f"test command could not run (exit {r.code}): {tail[-300:]}")
        body = box.exec(f"cat {shlex.quote(test_path)}")
        if missing := stack.missing_imports(box, body.output):
            return False, (f"the tests import {', '.join(missing)}, which no task builds, so they could never "
                           "pass; test only the task's module, the contracts and existing files"), tail
        n = stack.counts(r.output)
        if stack.collection_failed(r.code, r.output) or n["errors"]:
            return False, "the tests don't run cleanly (import, syntax or setup errors)", tail
        if mode == "change":
            if n["passed"] + n["failed"] < MIN_QA_TESTS:
                return False, f"write at least {MIN_QA_TESTS} tests", tail
            # All passing is fine when the change already holds, e.g. a migration in the change's contract set the
            # data the code reads. The dev task then only confirms it on main. Regression (Pawfect change 1): the
            # time-zone fix was complete once migration 0003 set the salon's zone; QA was required to write a
            # failing test for it, couldn't, and 4 of 5 tasks were lost.
            # A suite that passes in full needs a reviewer (a different model) to confirm it really tests the change,
            # or tests of unchanged behavior alone would declare the change done. The review runs later, from the dev
            # task, after this sandbox is gone. Regression (Pawfect change 1 retry): reviews run from inside the QA
            # check needed a second sandbox each; three at once hit Daytona's 10 GB limit and waited out their tries.
            if not n["failed"] and not can_confirm:
                return False, ("every test passes on the current code, so none of them checks the change; at least "
                               "one test must exercise the changed behavior and fail until it is made"), tail
            if state is not None:
                state["satisfied"] = not n["failed"]
        else:
            if n["passed"]:
                return False, (f"{n['passed']} test(s) already pass against the unimplemented stub, so they "
                               "check nothing; every test must exercise the behavior"), tail
            if n["failed"] < MIN_QA_TESTS:
                return False, f"write at least {MIN_QA_TESTS} tests", tail
            if stack.unimplemented_marker not in plain(r.output):
                return False, "the tests fail, but not because the code is unimplemented; check imports and setup", tail
        bucket.clear()
        bucket[test_path] = body.output
        return True, "", tail
    return check


# ---------------------------------------------------------------- referee
REFEREE_SPEC = """A dev agent implemented {module} for task {tid} ({title}), and some of the hidden acceptance tests
in {test_path} fail. Your job is to decide who is wrong, using only the spec below and the doc comments
in {module} (the stub's comments in the shared contract files too). The tests are in {test_path}.

Task spec: {spec}

Failing test output:
{output}

- If a failing test contradicts the spec or the doc comments (wrong arithmetic, wrong expected value, or an
  expectation the spec rules out), fix only that test so it matches the spec. Keep every other test as it is.
- A test that needs a file other than {module} that doesn't exist yet can never pass: remove that test.
- A test whose own setup fails (it inserts rows the schema, a constraint or a trigger refuses, before the code
  under test even runs) is wrong: fix the setup so it creates valid data the way the app would.
- If the failing tests are right, change nothing.
End with DONE if you corrected tests, or BLOCKED: tests are correct."""


def referee_check(test_path: str, stack: PythonStack, original: str, bucket: dict[str, str], mode: str = "new"):
    """A review counts only if it changed the tests and they still pass QA's rules (run cleanly, >= 3,
    every test fails on the stub because it's unimplemented; for a change, >= 1 fails on the current code)."""
    inner = qa_check(test_path, stack, {}, mode)

    def check(box: Sandbox) -> tuple[bool, str, str]:
        now = box.exec(f"cat {shlex.quote(test_path)}").output
        if now.strip() == original.strip():
            return False, "the reviewer confirmed the tests", ""
        ok, reason, out = inner(box)
        if ok:
            bucket.clear()
            bucket[test_path] = now
        return ok, reason, out
    return check


def make_dispute(t: dict, test_path: str, stack: PythonStack, bucket: dict[str, str], engine: Engine, referee,
                 mode: str = "new"):
    reviews = [0]

    def dispute(output: str) -> bool | None:
        if not bucket.get(test_path):
            return False
        reviews[0] += 1                                   # each review needs its own sandbox branch name
        rid = f"{t['id']}-review" + (str(reviews[0]) if reviews[0] > 1 else "")
        review = Task(rid, f"Review tests for {t['title']}",
                      REFEREE_SPEC.format(module=t["module"], tid=t["id"], title=t["title"], test_path=test_path,
                                          spec=t["spec"], output=output[-3000:]),
                      [test_path], "", role="qa", merge=False, max_attempts=1, agent=referee,
                      setup_files={test_path: bucket[test_path]},
                      check=referee_check(test_path, stack, bucket[test_path], bucket, mode))
        r = engine.run_task(review)
        if r.status == "passed":
            return True
        if r.status == "error" or (r.attempts and all(a.claim.startswith("error") for a in r.attempts)):
            return None                                  # the referee itself failed; it confirmed nothing
        return False
    return dispute


CONFIRM_SPEC = """QA wrote acceptance tests for change {tid} ({title}) to {module}, and every one of them passes on
the current code, before any dev work. That is fine only if the change is already in place (for example a migration
in this change already set the data the code reads). Decide which it is.

What the change is: {spec}

The tests are in {test_path}. Read them, the doc comments in {module}, and the change's contract files.
Write {verdict} with exactly one line: YES if the tests check the changed behavior described above (so their passing
shows the change already holds), or NO if they only check behavior that didn't change.
End with DONE."""


def already_done(state: dict, hidden: dict[str, str], test_path: str, confirm: Callable[[str], bool]):
    """For a change task's dev step: None when QA's tests fail on the current code (do the work as usual);
    "confirmed" when they all pass and a reviewer agrees they test the change; "unconfirmed" when they all pass
    but the reviewer doesn't agree (the tests can't show the change was made)."""
    def check() -> str | None:
        if not state.get("satisfied"):
            return None
        return "confirmed" if confirm(hidden.get(test_path, "")) else "unconfirmed"
    return check


def make_confirm(t: dict, test_path: str, engine: Engine, referee):
    """When every QA test passes on the current code, a different model checks that they test the change."""
    verdict = f"review/{t['id']}-verdict.txt"

    def confirm(tests: str) -> bool:
        def check(box: Sandbox) -> tuple[bool, str, str]:
            said = box.exec(f"cat {shlex.quote(verdict)} 2>/dev/null").output.strip().upper()
            yes = said.startswith("YES")
            return yes, "" if yes else "the reviewer did not confirm the tests check the change", said[:200]
        review = Task(f"{t['id']}-confirm", f"Confirm the change already holds: {t['title']}",
                      CONFIRM_SPEC.format(tid=t["id"], title=t["title"], module=t["module"], spec=t["spec"],
                                          test_path=test_path, verdict=verdict),
                      [verdict, test_path], "", role="qa", merge=False, max_attempts=1, agent=referee,
                      setup_files={test_path: tests}, check=check)
        return engine.run_task(review).status == "passed"
    return confirm


# -------------------------------------------------------------- tech lead
# docs/tech-lead.md. When a feature's dev task has failed every try, the tech lead (a stronger model than a Haiku
# dev, and never the agent whose work it reviews) reads the attempts and decides: more tries with its guidance, or
# one question for the owner. The engine runs it (Task.review_failure) and acts on the verdict.
TECH_LEAD_SPEC = """A dev agent tried task {tid} ({title}) {n} times and every attempt was rejected by the hidden acceptance
tests. You are its tech lead. Find out why, then decide: can another try succeed with your guidance, or does the
project owner have to decide something first?

What the dev had to do ({module}):
{spec}

Shared contracts (read-only): {contracts}.
The hidden acceptance tests that grade the dev are in {test_path} (the dev never sees them). {module} in this repo is
{base}; the dev's work is not in this repo, only in the diff below.

The attempts (why each was rejected, and the dev's final message):
{attempts}

End of the last attempt's test output:
{output}

The last attempt's changes (git diff):
{diff}
{retro}
The dev may edit only {module} and its own tests: the engine rejects an attempt that edits any other file, so
guidance that asks it to edit another file can't work. If the fix seems to need another file (for example a page still imports a name the change
removed), find a fix inside {module} that keeps the other files working, such as keeping the old export as a thin
wrapper over the new code; the integrator updates the other files after the features merge.

Write {verdict} with exactly this JSON and nothing else:
{{"decision": "retry" or "escalate",
  "note": "<for the dev, in plain English: what went wrong and exactly what to do instead>",
  "question": "<escalate only: one plain-English question for the project owner, with the options you see>",
  "stronger_model": true or false}}
- "retry" when you can see what the dev got wrong and how to fix it. "stronger_model": true when the dev understood
  the task but couldn't get the code right, so a stronger model should make the next tries.
- "escalate" when the feature can't be built as described: the spec contradicts itself, the tests or the contracts,
  or it needs something that doesn't exist. Ask the owner the one question that settles it; keep it under 250
  characters and free of code.
Don't change any other file. End with DONE."""


def parse_tech_lead_verdict(text: str) -> dict | None:
    """The tech lead's verdict file, read leniently (code fences, text around the JSON, "true" as a string), or
    None when it isn't usable: no JSON object, an unknown decision, a retry without a note, an escalation without
    a question."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(v, dict):
        return None
    decision = str(v.get("decision", "")).strip().lower()
    note, question = (" ".join(str(v.get(k) or "").split()) for k in ("note", "question"))
    stronger = v.get("stronger_model")
    stronger = stronger is True or (isinstance(stronger, str) and stronger.strip().lower() in ("true", "yes"))
    if decision == "retry" and note:
        return {"decision": "retry", "note": note, "question": "", "stronger_model": stronger}
    if decision == "escalate" and question:
        return {"decision": "escalate", "note": note, "question": question, "stronger_model": False}
    return None


def make_tech_lead(t: dict, test_path: str, hidden: dict[str, str], contracts: str, engine: Engine, tech_lead,
                   mode: str = "new", retro: str = ""):
    """Task.review_failure for a feature's dev task: runs the tech lead as its own task (on main, the hidden tests
    written in so it can read them, nothing merged) and returns its verdict. `retro` is the end of docs/retro.md
    (notes from earlier runs, docs/pm.md). Any failure is an escalation with
    tech_lead_error, so the owner is never left without a question."""
    verdict = f"review/{t['id']}-techlead.json"

    def review(attempts: list, diff: str) -> dict:
        found: dict = {}

        def check(box: Sandbox) -> tuple[bool, str, str]:
            said = box.exec(f"cat {shlex.quote(verdict)} 2>/dev/null").output
            v = parse_tech_lead_verdict(said)
            if v is None:
                return False, "the tech lead's verdict is missing or not valid", said[-500:]
            found.update(v)
            return True, "", said[-500:]

        lines = "\n".join(f"- Attempt {a.n}: {a.reason or 'rejected'}. The dev's final message: {a.claim}"
                          for a in attempts)
        last = attempts[-1] if attempts else None
        spec = TECH_LEAD_SPEC.format(
            tid=t["id"], title=t["title"], n=len(attempts), module=t["module"], spec=t["spec"], contracts=contracts,
            test_path=test_path, verdict=verdict, attempts=lines or "(none)",
            base=("the code before this change (the change's doc comments describe the new behavior)"
                  if mode == "change" else "the planner's stub (its doc comments are the spec)"),
            output=(last.test_output[-3000:] if last and last.test_output else "(none)"),
            diff=diff.strip() or "(no changes)", retro=retro_block(retro))
        task = Task(f"{t['id']}-techlead", f"Tech lead review: {t['title']}", spec, ["*"], "", role="tech_lead",
                    merge=False, max_attempts=1, agent=tech_lead, setup_files=dict(hidden), check=check)
        r = engine.run_task(task)
        if r.status == "passed" and found:
            return found
        why = r.error or (r.attempts[-1].reason if r.attempts else r.status)
        return {"decision": "escalate", "note": f"The review didn't finish: {why}"[:300], "tech_lead_error": True}
    return review


def owner_feedback(answer: str, question: str = "") -> str:
    """First-attempt feedback for a retried dev task whose tech lead asked the owner something."""
    asked = f" ({' '.join(question.split())})" if question else ""
    return f"The project owner answered the tech lead's question{asked}: {str(answer).strip()[:2000]}"


# ------------------------------------------------------------------ code reviewer
# docs/reviewer.md. When a feature's dev attempt passes every check, a different model from the dev reviews its diff
# before it merges, for what the tests can't catch. The engine runs it (Task.review_code) and acts on the verdict.
REVIEWER_SPEC = """A dev agent finished task {tid} ({title}) and its work passed every automated check, including the
hidden acceptance tests. You are the code reviewer, a different model from the dev. Read the change and decide whether
it can merge.

What the dev had to do ({module}):
{spec}

Shared contracts (read-only): {contracts}.
The hidden acceptance tests are in {test_path}, so you can see what is already tested. {module} in this repo is
{base}; the dev's work is not in this repo, only in the diff below.

The dev's changes (git diff):
{diff}
{second}
Write {verdict} with exactly this JSON and nothing else:
{{"verdict": "approve" or "changes",
  "comments": ["<one short, specific, plain-English comment: what is wrong, where, and what to do>", ...]}}
- "changes" ONLY for a real problem the tests didn't catch:
  - behavior the spec requires that is missing or wrong
  - a security problem: a missing sign-in, role or ownership check; one user's data reachable by another user;
    a secret in the code; SQL built from input. Start each such comment with "Security:".
  - data loss: deleting or overwriting data the spec says to keep
  - code that is a stub or a placeholder instead of the real behavior
- Never ask for changes over style, naming, formatting, structure or preferences. When unsure, approve.
- "approve" may carry comments as notes; they don't block anything. Keep comments few (at most 8).
- Never quote, name or describe the hidden tests or their file: your comments go to the dev, who must not see them.
  Point at the spec and the code instead.
Don't change any other file. End with DONE."""

REVIEWER_SECOND = """
This is your second review of this feature in this run: you already asked for changes once. Now ask for changes ONLY
for a security problem, with each such comment starting "Security:". For anything else, approve; you may still note
it in the comments.
"""


def parse_code_review(text: str) -> dict | None:
    """The reviewer's verdict file, read leniently (code fences, text around the JSON, a single comment as a string),
    or None when it isn't usable: no JSON object, an unknown verdict, or "changes" without a comment."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(v, dict):
        return None
    verdict = str(v.get("verdict", "")).strip().lower()
    raw = v.get("comments")
    raw = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
    comments = [c for c in (" ".join(str(x).split()) for x in raw if isinstance(x, (str, int, float))) if c]
    if verdict == "approve" or (verdict == "changes" and comments):
        return {"verdict": verdict, "comments": comments}
    return None


def make_reviewer(t: dict, test_path: str, hidden: dict[str, str], contracts: str, engine: Engine, reviewer,
                  mode: str = "new"):
    """Task.review_code for a feature's dev task: runs the code reviewer as its own task (on main, the hidden tests
    written in so it can read them, nothing merged) and returns its verdict. A review that doesn't finish, or writes
    no usable verdict, comes back as review_error (the engine then approves: a broken review never loses a feature)."""
    verdict = f"review/{t['id']}-review.json"
    reviews = [0]

    def review(diff: str, second: bool = False) -> dict:
        found: dict = {}

        def check(box: Sandbox) -> tuple[bool, str, str]:
            said = box.exec(f"cat {shlex.quote(verdict)} 2>/dev/null").output
            v = parse_code_review(said)
            if v is None:
                return False, "the reviewer's verdict is missing or not valid", said[-500:]
            found.update(v)
            return True, "", said[-500:]

        reviews[0] += 1                                   # each review needs its own sandbox branch name
        rid = f"{t['id']}-codereview" + (str(reviews[0]) if reviews[0] > 1 else "")
        spec = REVIEWER_SPEC.format(
            tid=t["id"], title=t["title"], module=t["module"], spec=t["spec"], contracts=contracts,
            test_path=test_path, verdict=verdict, diff=diff.strip() or "(no changes)",
            second=REVIEWER_SECOND if second else "",
            base=("the code before this change (the change's doc comments describe the new behavior)"
                  if mode == "change" else "the planner's stub (its doc comments are the spec)"))
        task = Task(rid, f"Code review: {t['title']}", spec, ["*"], "", role="reviewer", merge=False, max_attempts=1,
                    agent=reviewer, setup_files=dict(hidden), check=check)
        r = engine.run_task(task)
        if r.status == "passed" and found:
            return found
        why = r.error or (r.attempts[-1].reason if r.attempts else r.status)
        return {"review_error": True, "note": f"The review didn't finish: {why}"[:300]}
    return review


# ------------------------------------------------------------------ tasks
def tasks_from_plan(plan: dict, python_or_stack: "str | PythonStack" = "python3",
                    engine: Engine | None = None, referee=None, tech_lead=None, stronger_dev=None,
                    retro: str = "", reviewer=None) -> list[Task]:
    stack = python_or_stack if isinstance(python_or_stack, PythonStack) else default_stack(python_or_stack)
    by_id = {t["id"]: t for t in plan["tasks"]}
    contracts = ", ".join(plan["contracts"]) or "none"
    return [task for t in plan["tasks"]
            for task in feature_tasks(t, by_id, contracts, stack, engine, referee,
                                      tech_lead=tech_lead, stronger_dev=stronger_dev, retro=retro, reviewer=reviewer)]


def feature_tasks(t: dict, by_id: dict[str, dict], contracts: str, stack: PythonStack, engine: Engine | None,
                  referee, mode: str = "new", tech_lead=None, stronger_dev=None, retro: str = "",
                  reviewer=None) -> list[Task]:
    """A feature's QA task and dev task. mode "new" builds a stub; mode "change" changes a module that already
    works, so its tests and the dev's instructions say what may stay and what must change. With a `tech_lead`, a
    dev task that fails every try is reviewed before it gives up (docs/tech-lead.md); `stronger_dev` makes the
    tech lead's extra tries when it asks for a stronger model. With a `reviewer`, a dev attempt that passes every
    check is code reviewed by it before it merges (docs/reviewer.md)."""
    test_path = stack.qa_test_path(t["module"])
    hidden: dict[str, str] = {}                      # filled by the QA check, read by the dev's verify
    state: dict = {}                                 # QA check: does the change already hold on main?
    deps = t.get("depends_on", [])
    if mode == "change":
        qa_spec = (f"Write acceptance tests for change {t['id']} ({t['title']}) to {t['module']}, in {test_path}.\n\n"
                   f"What changes: {t['spec']}\n\n{t['module']} already works and other code uses it. Its doc "
                   "comments now describe the behavior after this change, but its code still does the old thing. "
                   "Test the changed behavior exactly as the doc comments say: at least one test must fail on the "
                   "current code, because the change isn't made yet. Tests of behavior that stays the same may "
                   "pass; add a few where the change could break it. If the code already does what the doc comments "
                   "say (for example a migration in this change already set the data it reads), write the tests "
                   "anyway; they may all pass, and the engine will confirm that on main."
                   + (f" If the doc comments describe a function that doesn't exist yet, `import {t['module'][:-3]}` "
                      f"and call `{t['module'][:-3]}.<function>(...)`, so one missing name doesn't stop the other "
                      "tests from running." if t["module"].endswith(".py") else "")
                   + f" Shared contracts: {contracts}.")
        dev_spec = (f"Change {t['module']} so it does exactly what its doc comments now say. The code already works "
                    "for the earlier behavior and other code uses it: keep everything the doc comments still "
                    "describe, and keep existing signatures unless the doc comments change them."
                    f"\n\nWhat changes: {t['spec']}\n\nShared contracts (read-only): {contracts}.")
    else:
        qa_spec = (f"Write acceptance tests for task {t['id']} ({t['title']}), module {t['module']}, in {test_path}.\n\n"
                   f"Task spec: {t['spec']}\n\nThe stub {t['module']} has the signatures and doc comments; those "
                   f"are the exact behavior to test. Shared contracts: {contracts}.")
        dev_spec = (f"Implement everything in {t['module']}. The stub's signatures and doc comments are the spec; "
                    f"keep the signatures exactly.\n\n{t['spec']}\n\nShared contracts (read-only): {contracts}.")
    builds_on = "".join(f"\n- {d}: {by_id[d]['module']} ({by_id[d]['title']})" for d in deps)
    return [
        Task(f"{t['id']}-qa", f"Acceptance tests for {t['title']}", qa_spec,
             [test_path], "", role="qa", merge=False,
             check=qa_check(test_path, stack, hidden, mode, state, can_confirm=bool(engine and referee))),
        Task(t["id"], t["title"],
             dev_spec + f"\n\nYou may only edit {t['module']}. If you add your own tests, they must match "
             f"{stack.dev_test_glob(t['module'])} (any other file gets your work rejected)."
             + (f"\n\nThis builds on finished, tested work already in the repo. Import and reuse it; "
                f"you cannot edit it:{builds_on}" if deps else ""),
             [t["module"], stack.dev_test_glob(t["module"])],
             stack.verify_cmd(t["module"], test_path),
             hidden_tests=hidden, depends_on=[*deps, f"{t['id']}-qa"],
             already_done=already_done(state, hidden, test_path, make_confirm(t, test_path, engine, referee))
             if mode == "change" and engine and referee else None,
             dispute=make_dispute(t, test_path, stack, hidden, engine, referee, mode) if engine and referee else None,
             review_failure=make_tech_lead(t, test_path, hidden, contracts, engine, tech_lead, mode, retro)
             if engine and tech_lead and mode in ("new", "change") else None,
             stronger_agent=stronger_dev if engine and tech_lead and mode in ("new", "change") else None,
             review_code=make_reviewer(t, test_path, hidden, contracts, engine, reviewer, mode)
             if engine and reviewer and mode in ("new", "change") else None)]


# ------------------------------------------------------------- integration
INTEGRATION_SPEC = """Every feature of this project is built, tested and merged. Turn them into a working website.

Project brief and design:
{description}

Built and tested modules (read their doc comments; you cannot edit them):
{modules}
{saved}
Pages the app must have: {pages}

How to wire it (read AGENTS.md first):
- Each page is src/app/<route>/page.tsx. Server components load data with
  `const actor = await requireActor()` (src/lib/session.ts) and `const db = await getDb()` (src/lib/runtime.ts),
  call the server functions and render the components. Pages for signed-out people (sign-in, sign-up,
  the home page) must not require a session.
- Changes go through server actions ("use server", for example src/app/book/actions.ts): get db and actor the
  same way, call the server function, catch AppError and return its message for the form to show, then
  revalidatePath or redirect. Never let an AppError crash a page.
- Sign-up, sign-in, sign-out and password changes use getAuth() from src/lib/session.ts inside server actions;
  after sign-up, call the project's own account functions (for example, create the profile).
- Components that need callbacks: pass server actions, or write a small "use client" wrapper in src/app/.
- If a component module still throws "Not implemented" (its feature didn't pass its tests), don't import it:
  build that screen yourself in src/app/ from its doc comments.
- Send people to the right page for their role and keep others out, using the project's server functions.
- The app's owner is its admin (src/lib/owner.ts, a template file). Admin pages and admin links check
  `isOwner(db, actor)` / `requireOwner(db, actor)`; never a role someone would have to set in the database.
- You MUST add an /owner-setup page (src/app/owner-setup/page.tsx), where the owner claims the app:
  - signed out: the heading "Set up the owner account" and links to sign up and sign in first (come back here after);
  - signed in, ownerSetupState(db) is "open": the heading "Set up the owner account", a "Setup code" field and a
    "Claim owner" button; a server action calls claimOwner(db, actor, code), shows the AppError's message on a
    wrong code, and on success redirects to the admin home (or "/" if the app has no admin pages);
  - "claimed": "This app already has an owner." (and a link home);
  - "not_configured": "Owner setup isn't configured for this app."
  Link it from the sign-in page's footer as "Owner setup". It must load without a session.
- A simple header with links to the main pages in src/app/layout.tsx, styled with the look in the brief.
- The root layout src/app/layout.tsx MUST render the template's Studio bridge inside <body>:
  `import {{ StudioBridge }} from "@/lib/studio-bridge";` and `<StudioBridge />`. It tells Studio's preview which
  page is open (nothing else) so the owner's comment pins land on the right page. Keep it if you rewrite the layout.
- You may only edit files under src/app/, src/middleware.ts, and your own tests under tests/unit/.

Before saying DONE, run all of this and fix anything that fails:
{check}"""


def integration_check(stack: PythonStack, pages: list[str], bridge: bool = False):
    """The whole-app check. With `bridge` (the integrator's, not a quick change's: apps built before the bridge
    existed get it on their next integration), the root layout must also render the template's StudioBridge."""
    cmd = stack.integration_check_cmd(pages)
    bridge_problem = getattr(stack, "bridge_problem", None) if bridge else None

    def check(box: Sandbox) -> tuple[bool, str, str]:
        if bridge_problem:
            r = box.exec("cat src/app/layout.tsx")
            problem = bridge_problem(r.output if r.code == 0 else None)
            if problem:
                return False, f"{problem} (the Studio bridge; see the instructions)", problem
        r = box.exec(cmd, timeout=1500)
        tail = failure_excerpt(r.output)
        if r.code != 0:
            return False, "the app doesn't build, or a page is missing or fails (see the output)", tail
        return True, "", tail
    return check


CHANGE_INTEGRATION_NOTE = """This app is already built and working, and its pages in src/app/ exist. A change to it was
just built, tested and merged. Update the pages for this change and keep everything else as it works now.

The user asked for: {request}
What changes: {summary}
Modules this change touched: {touched}

Some of the project's own tests in tests/unit/ may still expect the behavior this change replaced (the full test
run in the check below will show them). Update those expectations to the new behavior; never delete a test of
behavior that stays."""


def integration_task(plan: dict, description: str, stack: PythonStack, agent=None, change: dict | None = None,
                     deferred=()) -> Task:
    """The last task: pages, sign-in and server actions that connect every merged feature. It needs every
    server module, but only waits for UI components: if one never passed its tests, the integrator builds that
    screen itself inside src/app/, still checked by the build and page checks. Regression (Pawfect builds 6-7):
    one screen component that kept failing its tests blocked the whole app every time.
    With a `change`, it runs again after the change's tasks (and waits only for those): the pages are updated
    for the change, and its check runs the whole test suite, so a change that broke earlier work fails here.
    `deferred`: features saved for later (docs/pm.md). They aren't built, so it neither waits for them nor
    imports their modules; its spec names them."""
    current = apply_change(plan, change) if change else plan
    saved = set(deferred or ())
    pages = [r for r in current.get("pages", []) if isinstance(r, str)] or ["/"]
    pages += [r for r in getattr(stack, "required_pages", ()) if r not in pages]     # /owner-setup on the web stack
    waits_on = [t for t in (change["tasks"] if change else plan["tasks"]) if t["id"] not in saved]
    ui = [t["id"] for t in waits_on if stack.is_ui_module(t["module"])]
    modules = "\n".join(f"- {t['module']}: {t['title']}" for t in current["tasks"] if t["id"] not in saved)
    spec = INTEGRATION_SPEC.format(description=description.strip(), modules=modules, pages=", ".join(pages),
                                   check=stack.integration_check_cmd(pages),
                                   saved=saved_note([t for t in current["tasks"] if t["id"] in saved]))
    if change:
        touched = ", ".join(t["module"] for t in change["tasks"])
        spec = CHANGE_INTEGRATION_NOTE.format(request=change.get("request", ""), summary=change.get("summary", ""),
                                              touched=touched) + "\n\n" + spec
    return Task("INT", "Integrate: pages, sign-in and data" if not change else "Integrate the change: pages and data",
                spec, list(stack.integration_scope), "", role="dev", agent=agent,
                depends_on=[t["id"] for t in waits_on if t["id"] not in ui], waits_for=ui,
                check=integration_check(stack, pages, bridge=True))


# -------------------------------------------------------------------- run
Approver = Callable[[dict], "tuple[bool, str]"]


def auto_approve(plan: dict) -> tuple[bool, str]:
    return True, "approved automatically"


def run_project(description: str, repo: Path, engine: Engine, python: str = "python3",
                parallel: int = 4, approve: Approver = auto_approve,
                stack: PythonStack | None = None, save_tests: Path | None = None,
                referee=None, integrator=None, tech_lead=None, stronger_dev=None,
                deferred=(), reviewer=None) -> tuple[dict | None, list[Result]]:
    """Plan, then pause for approval, then QA + build. `approve(plan)` returns (approved, note); in the
    app it waits for the user's click, offline it approves automatically. `referee` is the agent that settles
    test disputes; a different model from QA's, so work is never graded only by the model that wrote it.
    `reviewer` code reviews each feature's passing attempt before it merges (docs/reviewer.md).
    `deferred`: task ids the owner saved for later (docs/pm.md), or a function of the plan that returns them,
    called after approval (the owner picks them on the approval screen). They are not built."""
    emit = engine.events.emit
    stack = stack or default_stack(python)
    planner = planning_task(description, stack)
    emit("task_queued", planner.id, title=planner.title, role="planner", depends_on=[])
    plan_result = engine.run_task(planner)
    if plan_result.status != "merged":
        return None, [plan_result]
    plan = json.loads((Path(repo) / "plan.json").read_text())
    emit("plan_ready", plan=plan)
    approved, note = approve(plan)
    emit("plan_decision", approved=approved, note=note)
    if not approved:
        return plan, [plan_result]
    saved = saved_ids(plan, deferred(plan) if callable(deferred) else deferred)
    emit_deferred(engine, plan, saved)
    tasks = tasks_from_plan(without(plan, saved), stack, engine=engine, referee=referee, tech_lead=tech_lead,
                            stronger_dev=stronger_dev, reviewer=reviewer)
    if stack.integration:
        tasks.append(integration_task(plan, description, stack, agent=integrator, deferred=saved))
    return plan, [plan_result, *build(tasks, engine, parallel, save_tests)]


def emit_deferred(engine: Engine, plan: dict, saved: list[str]) -> None:
    """pm_deferred {tasks, titles} at the start of a build that leaves features for later (only then)."""
    if saved:
        title = {t["id"]: t.get("title", t["id"]) for t in plan["tasks"]}
        engine.events.emit("pm_deferred", tasks=list(saved), titles=[title[i] for i in saved])


def build(tasks: list[Task], engine: Engine, parallel: int, save_tests: Path | None) -> list[Result]:
    try:
        results = engine.run_all(tasks, parallel=parallel)
    finally:
        if save_tests:              # keep the hidden tests for review (never merged, never shown to devs)
            for t in tasks:
                for path, body in t.hidden_tests.items():
                    dest = Path(save_tests) / path
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(body)
    return results


def resume_tasks(plan: dict, description: str, stack: PythonStack, merged: set[str], engine: Engine | None = None,
                 referee=None, integrator=None, change: dict | None = None, tech_lead=None, stronger_dev=None,
                 answers: dict[str, str] | None = None, questions: dict[str, str] | None = None,
                 deferred=(), retro: str = "", reviewer=None) -> list[Task]:
    """The tasks still to do after a stopped build: every feature (its QA and dev task) and the integration
    that hadn't merged. Merged work stays as it is in the repo; nothing depends on it any more.
    `change` is the latest approved change (changes/{n}.json on main): its tasks that didn't merge are redone as
    it planned them. Its "change" tasks have to come from there: plan.json only holds the new spec under the
    owning task's id (T2), which merged long ago.
    `deferred`: features still saved for later (docs/pm.md); they stay unbuilt. When the integration merged in an
    earlier run but features are built now (the owner's "Build saved features"), it runs again to wire them in.
    `retro`: the end of docs/retro.md, for the tech lead."""
    ids = {t["id"] for t in change["tasks"]} if change else set()
    saved = [i for i in saved_ids(plan, deferred) if i not in merged]
    tasks = tasks_from_plan(dict(plan, tasks=[t for t in plan["tasks"] if t["id"] not in ids and t["id"] not in saved]),
                            stack, engine=engine, referee=referee, tech_lead=tech_lead, stronger_dev=stronger_dev,
                            retro=retro, reviewer=reviewer)
    if change:
        tasks += tasks_from_change(change, plan, stack, engine=engine, referee=referee, tech_lead=tech_lead,
                                   stronger_dev=stronger_dev, retro=retro, reviewer=reviewer)
    feature = lambda tid: tid.removesuffix("-qa")                      # noqa: E731
    if stack.integration:
        integ = integration_task(plan, description, stack, agent=integrator, change=change, deferred=saved)
        devs = [t.id for t in tasks if not t.id.endswith("-qa")]
        modules = {t.id: t.can_edit[0] for t in tasks}
        integ.depends_on = [d for d in devs if not stack.is_ui_module(modules[d])]
        integ.waits_for = [d for d in devs if stack.is_ui_module(modules[d])]
        tasks.append(integ)
        if "INT" in merged and any(d not in merged for d in devs):
            merged = set(merged) - {"INT"}                              # new features to wire in: integrate again
    todo = [t for t in tasks if feature(t.id) not in merged]
    for t in todo:
        t.depends_on = [d for d in t.depends_on if feature(d) not in merged]
        t.waits_for = [d for d in t.waits_for if feature(d) not in merged]
        # The owner answered the tech lead's question about this feature: its dev reads the answer on its first
        # try. Only the dev task (QA's tests come from the spec), and only the feature it was asked about.
        answer = (answers or {}).get(t.id)
        if answer and str(answer).strip() and t.role == "dev" and t.id != "INT" and not t.id.endswith("-qa"):
            t.first_feedback = owner_feedback(answer, (questions or {}).get(t.id, ""))
    return todo


def latest_change(repo: Path) -> dict | None:
    """The newest changes/{n}.json on main. A rejected change's file is reverted, so any file here was approved."""
    found = []
    for f in (Path(repo) / "changes").glob("*.json"):
        try:
            change = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if f.stem.isdigit() and isinstance(change, dict) and isinstance(change.get("tasks"), list):
            found.append((int(f.stem), change))
    return max(found, key=lambda x: x[0])[1] if found else None


def resume_project(plan: dict, description: str, repo: Path, engine: Engine, merged: set[str],
                   stack: PythonStack | None = None, parallel: int = 4, save_tests: Path | None = None,
                   referee=None, integrator=None, tech_lead=None, stronger_dev=None,
                   answers: dict[str, str] | None = None, deferred=(), reviewer=None) -> list[Result]:
    """Retry only what didn't finish, in the same repo, without planning or approval again. `answers` are the
    owner's answers to the tech lead's questions, by task id (docs/tech-lead.md). `deferred`: features still saved
    for later (docs/pm.md), skipped again; the tech lead reads the end of docs/retro.md. `reviewer`: the code
    reviewer (docs/reviewer.md)."""
    stack = stack or default_stack()
    saved = [i for i in saved_ids(plan, deferred) if i not in merged]
    todo = resume_tasks(plan, description, stack, merged, engine=engine, referee=referee, integrator=integrator,
                        change=latest_change(repo), tech_lead=tech_lead, stronger_dev=stronger_dev, answers=answers,
                        deferred=saved, retro=read_retro(repo), reviewer=reviewer)
    engine.events.emit("build_resumed", merged=sorted(merged),
                       retrying=sorted({t.id.removesuffix("-qa") for t in todo}))
    emit_deferred(engine, plan, saved)
    return build(todo, engine, parallel, save_tests)


# ------------------------------------------------------------------ change requests
# A change to a project that is already built (docs/change-requests.md is the contract with the app):
# plan only the change, wait for approval, build it in the same repo. Merged work stays; the engine still
# verifies everything, and the integration check runs the whole test suite again for web apps.
CHANGE_KINDS = ("change", "new")

CHANGE_GUIDE = """Plan a change to a project that is already built and working. A team of AI agents will build only
this change, in the same repo; everything already built stays.

The change the user asked for:
{request}

Read plan.json first (the original plan: every task, the module it owns and its spec), then AGENTS.md and the
code of the modules the change touches.

How this project's contracts and stubs are written (from the original planning rules; where they say
plan.json, write changes/{n}.json instead, and never edit plan.json, the engine updates it after the build):
{layout}

Write changes/{n}.json, exactly this shape:
   {{"n": {n},
     "request": "<the user's words, as above>",
     "summary": "<one or two plain sentences: what will change>",
     "contracts": ["<contract file this change adds or edits>", ...],
     "tasks": [{{"id": "C{n}T1", "kind": "change", "title": "<short>", "module": "<a task module from plan.json>",
                "spec": "<what changes, precise enough to test>", "depends_on": []}},
               {{"id": "C{n}T2", "kind": "new", "title": "<short>", "module": "<a new module>",
                "spec": "<what to build>", "depends_on": ["C{n}T1"]}}]{pages_line}}}
   - 1 to {max_tasks} tasks, with ids C{n}T1, C{n}T2, ... Each task owns one module and no module is shared.
   - kind "change": a module that already exists and is a task module in plan.json. Keep its code exactly as it
     is (a dev agent changes the code) and rewrite its doc comments so they describe the behavior after the
     change: they are the spec QA tests against. Never stub out, delete or replace the existing code, and never
     add a `{stub_marker}` body to it. If the change adds a function to an existing module, describe its exact
     signature and behavior in the task spec and in a comment in the module; the dev writes it.
   - Never remove or rename an exported function, type or constant that other modules or pages use: say in the
     spec that the old name stays, working, as a thin wrapper over the new code. Each dev agent may edit only
     its own module, so a removed name breaks the type check of files nobody in the change can edit. The
     integrator moves the callers to the new code afterwards. (Regression: Tool library change 1 removed
     requireAdmin, two pages still imported it, and the feature failed all five tries.)
   - kind "new": a module that doesn't exist yet, written as a stub exactly like the original plan's stubs.
   - depends_on lists ids of tasks in this change only (earlier work is already merged); no cycles.
   - "contracts": every contract file this change adds or edits ({contract_rule}). Contract edits must be
     additive: existing code must keep working with them.{migration_rule}
   - Every file you create or edit must be listed in changes/{n}.json, as a contract or a task module.{pages_rule}
{retro}
Project brief:
{description}"""


def code_size(path: str, text: str) -> int:
    """Lines of code with comments and docstrings left out. A change planner may rewrite doc comments but never
    code, so this must not shrink."""
    if path.endswith(".py"):
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return 0
        doc = lambda n: isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)  # noqa: E731
        return sum(1 for n in ast.walk(tree) if isinstance(n, ast.stmt) and not doc(n))
    code = re.sub(r"(?m)//.*$", "", re.sub(r"/\*[\s\S]*?\*/", "", text))
    return sum(1 for line in code.splitlines() if line.strip())


def _migration_numbers(stack: PythonStack, files) -> list[int]:
    rx = stack.migration_re
    return sorted(int(m.group(1)) for f in files if rx and (m := rx.match(f)))


def change_problems(change, plan: dict, stack: PythonStack | None = None, repo_files=()) -> list[str]:
    """Everything wrong with changes/{n}.json, in words a planner can act on. `repo_files` are the files in the
    repo before the change (a "change" task needs one of them; a "new" task and a new migration must not)."""
    stack = stack or default_stack()
    if not isinstance(change, dict):
        return ["the change file must be a JSON object"]
    n = change.get("n")
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        return ['"n" must be the change number']
    p = []
    for key in ("request", "summary"):
        if not isinstance(change.get(key), str) or not change[key].strip():
            p.append(f'"{key}" must be a non-empty string')
    contracts, tasks = change.get("contracts", []), change.get("tasks")
    if not isinstance(contracts, list) or not all(isinstance(c, str) for c in contracts):
        return p + ['"contracts" must be a list of file names']
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        return p + [f'"tasks" must be a list of 1 to {MAX_TASKS} tasks']
    files = set(repo_files)
    plan_owner = {t["module"]: t.get("id") for t in plan.get("tasks", []) if isinstance(t, dict) and "module" in t}
    numbers = _migration_numbers(stack, files)
    owners: dict[str, str] = {}
    for c in contracts:
        mig = stack.migration_re.match(c) if stack.migration_re else None
        if not stack.contract_re.match(c) or c in stack.reserved:
            p.append(f"contract {c!r} must be {stack.contract_rule}")
        elif c in plan_owner:
            p.append(f"{c} is the module of task {plan_owner[c]}, not a contract; change it with a task")
        elif mig and c in files:
            p.append(f"{c} already exists: never edit an existing migration; add a new one")
        elif mig and numbers and int(mig.group(1)) <= numbers[-1]:
            p.append(f"new migration {c} must be numbered after the last one ({numbers[-1]:04d})")
        owners[c] = "contracts"
    id_re = re.compile(rf"^C{n}T[1-9][0-9]?$")
    ids: list[str] = []
    scope = getattr(stack, "integration_scope", []) if stack.integration else []
    for t in tasks:
        if not isinstance(t, dict):
            p.append("every task must be an object")
            continue
        tid = t.get("id")
        if not isinstance(tid, str) or not id_re.match(tid):
            p.append(f"task id {tid!r} must be C{n}T1, C{n}T2, ...")
            continue
        if tid in ids:
            p.append(f"task id {tid} is used twice")
            continue
        ids.append(tid)
        kind = t.get("kind")
        if kind not in CHANGE_KINDS:
            p.append(f'{tid}: "kind" must be "change" or "new"')
        for key in ("title", "spec"):
            if not isinstance(t.get(key), str) or not t[key].strip():
                p.append(f"{tid}: {key!r} must be a non-empty string")
        mod = t.get("module")
        if not isinstance(mod, str) or not stack.module_re.match(mod) or mod in stack.reserved:
            p.append(f"{tid}: module {mod!r} must be {stack.module_rule}")
        elif any(fnmatch(mod, s) for s in scope):
            p.append(f"{tid}: pages ({mod}) get no task of their own; describe the fix in \"summary\" and the "
                     "integrator makes it")
        elif mod in owners:
            p.append(f"{tid}: module {mod} is already owned by {owners[mod]}; each module has one owner")
        else:
            owners[mod] = tid
            if kind == "change" and mod not in files:
                p.append(f'{tid}: kind "change" needs a module that exists, and {mod} doesn\'t (use kind "new")')
            elif kind == "change" and mod not in plan_owner:
                p.append(f"{tid}: {mod} isn't a task module in plan.json; only task modules can be changed")
            elif kind == "new" and (mod in files or mod in plan_owner):
                p.append(f'{tid}: kind "new" needs a new module, and {mod} already exists (use kind "change")')
        deps = t.get("depends_on", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            p.append(f"{tid}: depends_on must be a list of task ids")
    if "pages" in change or stack.integration:
        pages = change.get("pages")
        if (not isinstance(pages, list) or (stack.integration and not pages)
                or not all(isinstance(r, str) and re.match(r"^/[A-Za-z0-9_\-/]*$", r) for r in pages)):
            p.append('"pages" must be a list of every page route after the change, like "/book" (no dynamic segments)')
    if p:
        return p
    for t in tasks:
        if unknown := [d for d in t.get("depends_on", []) if d not in ids]:
            p.append(f"{t['id']}: depends_on may only name tasks in this change ({', '.join(unknown)} isn't one; "
                     "earlier work is already merged)")
    slugs = [stack.slug(t["module"]) for t in tasks]
    if len(set(slugs)) != len(slugs):
        p.append("two task modules would share a test file name; give them distinct names")
    if p:
        return p
    try:
        check_graph([Task(t["id"], t["title"], "", [], "", depends_on=t.get("depends_on", [])) for t in tasks])
    except GraphError as e:
        p.append(str(e))
    return p


def change_check(n: int, request: str, plan: dict, stack: PythonStack):
    path = f"changes/{n}.json"

    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec(f"cat {path}")
        if r.code:
            return False, f"{path} is missing", ""
        try:
            change = json.loads(r.output)
        except json.JSONDecodeError as e:
            return False, f"{path} is not valid JSON ({e})", ""
        base = box.exec("git merge-base HEAD main").output.strip()
        existed = set(box.exec(f"git ls-tree -r --name-only {base}").output.split())
        if isinstance(change, dict):
            # The record keeps the user's own words and its number, whatever the planner wrote; template files
            # listed as contracts are dropped, as in planning.
            change["n"], change["request"] = n, request
            if isinstance(change.get("contracts"), list):
                change["contracts"] = [c for c in change["contracts"] if c not in stack.reserved]
            box.write_file(path, json.dumps(change, indent=2))
        if problems := change_problems(change, plan, stack, existed):
            return False, "the change has problems: " + "; ".join(problems), ""
        changed = sorted(set(box.exec(f"git diff --name-only {base}; "
                                      "git ls-files --others --exclude-standard").output.split()))
        rx = stack.migration_re
        if rx and (edited := [f for f in changed if f in existed and rx.match(f)]):
            return False, (f"never edit an existing migration ({', '.join(edited)}): it has already been applied; "
                           "add a new one numbered after the last"), ""
        if not stack.nested_files_ok and (nested := [f for f in changed if "/" in f and f != path]):
            return False, f"planning files must be top-level; remove {', '.join(nested)}", ""
        tasks = change["tasks"]
        modules = [t["module"] for t in tasks]
        expected = set(modules) | set(change["contracts"]) | {path}
        extra = sorted(set(changed) - expected)
        # Stray edits to existing files (plan.json, template files, modules the change doesn't name) are undone,
        # as in planning: nothing in the change depends on them.
        if stray := [f for f in extra if f in existed]:
            box.exec(f"git checkout {base} -- " + " ".join(shlex.quote(f) for f in stray))
            extra = [f for f in extra if f not in existed]
        if extra:
            return False, f"files not named in {path}: {', '.join(extra)}", ""
        if missing := [f for f in sorted(expected) if box.exec(f"test -f {shlex.quote(f)}").code]:
            return False, f"{path} names files that don't exist: {', '.join(missing)}", ""
        # Its doc comments are the spec QA tests against; unchanged, they still describe the old behavior.
        if same := [t["module"] for t in tasks if t["kind"] == "change" and t["module"] not in changed]:
            return False, f"update the doc comments of {', '.join(same)} to describe the behavior after the change", ""
        chk = box.exec(stack.plan_check_cmd(change["contracts"], modules), timeout=900)
        if stack.runner_missing(chk.code, chk.output):
            raise SetupError(f"the checks could not run in the sandbox: {chk.output[-300:]}")
        if chk.code:
            return False, "the contracts and modules don't pass the checks (types, imports or migrations)", chk.output[-2000:]
        marker = stack.stub_marker
        for t in tasks:
            q = shlex.quote(t["module"])
            now = box.exec(f"cat {q}").output
            if t["kind"] == "new":
                if marker not in now:
                    return False, f"new task modules must be stubs ({marker}): {t['module']}", ""
                continue
            before = box.exec(f"git show {base}:{q}").output
            # Regression guard (contract: implementations stay): an existing module rewritten as a stub would
            # throw away merged, tested work, and its QA tests would pass the "fails now" rule trivially.
            if now.count(marker) > before.count(marker) or code_size(t["module"], now) < code_size(t["module"], before):
                return False, (f"{t['module']} already works: keep its code exactly as it is and change only its "
                               "doc comments; the dev agent changes the code"), ""
        return True, "", f"change OK: {len(tasks)} tasks"
    return check


def change_planning_task(n: int, request: str, plan: dict, stack: PythonStack, description: str = "",
                         retro: str = "") -> Task:
    """`retro`: the end of docs/retro.md (what failed in earlier runs and why, docs/pm.md)."""
    web = stack.integration
    rx = stack.migration_re
    return Task(f"C{n}PLAN", "Plan the change",
                CHANGE_GUIDE.format(
                    n=n, request=request.strip(), layout=stack.plan_layout, max_tasks=MAX_TASKS, retro=retro_block(retro),
                    stub_marker=stack.stub_marker, contract_rule=stack.contract_rule,
                    description=(description or plan.get("project", "")).strip(),
                    migration_rule=("\n     Migrations: add new ones only, numbered after the last existing one; "
                                    "never edit an existing migration (it has already been applied).") if rx else "",
                    pages_line=(',\n     "pages": ["/", "..."]' if web else ""),
                    pages_rule=("\n   - \"pages\": every page route the app has after the change. Fixes to pages "
                                "(src/app/) get no task of their own: describe them in \"summary\" and the "
                                "integrator makes them after the tasks merge." if web else "")),
                ["*"], "", role="planner", check=change_check(n, request, plan, stack))


def tasks_from_change(change: dict, plan: dict, stack: PythonStack, engine: Engine | None = None,
                      referee=None, tech_lead=None, stronger_dev=None, retro: str = "", reviewer=None) -> list[Task]:
    """QA + dev tasks for a change. Dependencies stay inside the change: earlier work is already merged."""
    by_id = {t["id"]: t for t in change["tasks"]}
    contracts = ", ".join(dict.fromkeys([*plan.get("contracts", []), *change.get("contracts", [])])) or "none"
    return [task for t in change["tasks"]
            for task in feature_tasks(t, by_id, contracts, stack, engine, referee, mode=t["kind"],
                                      tech_lead=tech_lead, stronger_dev=stronger_dev, retro=retro, reviewer=reviewer)]


def apply_change(plan: dict, change: dict) -> dict:
    """plan.json after a change: a "change" task replaces the spec of the task that owns its module, a "new"
    task is appended (its depends_on renamed to the plan ids those modules have), new contracts are added, and
    the change's pages replace the plan's."""
    new = copy.deepcopy(plan)
    owner = {t["module"]: t for t in new["tasks"]}
    plan_id = {}
    for t in change["tasks"]:
        if t["kind"] == "change" and t["module"] in owner:
            owner[t["module"]]["spec"] = t["spec"]
            plan_id[t["id"]] = owner[t["module"]]["id"]
        else:
            plan_id[t["id"]] = t["id"]
    have = {t["id"] for t in new["tasks"]}
    for t in change["tasks"]:
        if plan_id[t["id"]] == t["id"] and t["id"] not in have:          # applying twice changes nothing
            new["tasks"].append({"id": t["id"], "title": t["title"], "module": t["module"], "spec": t["spec"],
                                 "depends_on": [plan_id.get(d, d) for d in t.get("depends_on", [])]})
    new["contracts"] = list(dict.fromkeys([*new.get("contracts", []), *change.get("contracts", [])]))
    if "pages" in change:
        new["pages"] = list(change["pages"])
    return new


def commit_on_main(engine: Engine, files: dict[str, str], message: str) -> bool:
    """Commit files the engine itself writes (plan.json) straight to main. Serialized with merges (merge_lock)
    and with worktree changes (repo_lock) like Engine.merge, and pushed like a merge when there is a remote."""
    repo = engine.repo
    with engine.merge_lock, repo_lock(repo):
        for path, body in files.items():
            (repo / path).write_text(body)
        git(["add", "--", *files], repo)
        if git(["diff", "--cached", "--quiet"], repo).returncode == 0:
            return True                                     # nothing changed
        if git(["commit", "-qm", message], repo).returncode:
            git(["reset", "-q", "--", *files], repo)
            return False
        return not engine.remote or git(["push", "-q", "origin", "main"], repo).returncode == 0


def undo_merge(engine: Engine, task_id: str) -> bool:
    """Revert the merge of one task on main (and push). A rejected change must not leave its new migrations and
    rewritten doc comments behind: the next change would plan on top of a spec nobody approved."""
    repo = engine.repo
    with engine.merge_lock, repo_lock(repo):
        sha = git(["log", "--merges", "-1", "--format=%H", f"--grep=^merge {task_id}$"], repo).stdout.strip()
        if not sha:
            return False
        if git(["revert", "--no-edit", "-m", "1", sha], repo).returncode:
            git(["revert", "--abort"], repo)
            return False
        return not engine.remote or git(["push", "-q", "origin", "main"], repo).returncode == 0


def change_project(n: int, request: str, description: str, repo: Path, engine: Engine,
                   approve: Approver = auto_approve, stack: PythonStack | None = None, parallel: int = 4,
                   save_tests: Path | None = None, referee=None, integrator=None, tech_lead=None,
                   stronger_dev=None, deferred=(), reviewer=None) -> tuple[dict | None, list[Result]]:
    """Plan change n, pause for approval, record it in plan.json, then QA + build it in the same repo (and
    integrate again for web apps). Returns (change, results): change is None if planning failed; results is just
    the planner's if the change was rejected (its merge is reverted then). The planner and the tech lead read the
    end of docs/retro.md; `deferred` features (still saved for later, docs/pm.md) are named to the integrator.
    `reviewer`: the code reviewer of each change task's passing attempt (docs/reviewer.md)."""
    emit = engine.events.emit
    stack = stack or default_stack()
    repo = Path(repo)
    emit("change_started", n=n, text=request)
    plan = json.loads((repo / "plan.json").read_text())
    retro = read_retro(repo)
    planner = change_planning_task(n, request, plan, stack, description, retro=retro)
    emit("task_queued", planner.id, title=planner.title, role="planner", depends_on=[])
    plan_result = engine.run_task(planner)
    if plan_result.status != "merged":
        return None, [plan_result]
    change = json.loads((repo / "changes" / f"{n}.json").read_text())
    emit("change_plan_ready", n=n, change=change)
    approved, note = approve(change)
    emit("plan_decision", approved=approved, note=note)
    if not approved:
        undo_merge(engine, planner.id)
        return change, [plan_result]
    # Recorded before the build, so a worker that dies mid-build still leaves plan.json matching the doc comments
    # already on main; a retry rebuilds what didn't merge from plan.json and changes/{n}.json (resume_tasks).
    commit_on_main(engine, {"plan.json": json.dumps(apply_change(plan, change), indent=2) + "\n"},
                   f"plan.json: change {n}")
    tasks = tasks_from_change(change, plan, stack, engine=engine, referee=referee, tech_lead=tech_lead,
                              stronger_dev=stronger_dev, retro=retro, reviewer=reviewer)
    if stack.integration:
        changed = {t["module"] for t in change["tasks"]}            # a change to a saved feature's module builds it
        saved = [i for i in saved_ids(plan, deferred)
                 if not any(t["id"] == i and t["module"] in changed for t in plan["tasks"])]
        tasks.append(integration_task(plan, description, stack, agent=integrator, change=change, deferred=saved))
    return change, [plan_result, *build(tasks, engine, parallel, save_tests)]
