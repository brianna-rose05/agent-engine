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

import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Callable

from engine.engine import Engine, GraphError, Result, SetupError, check_graph, failure_excerpt
from engine.interfaces import Sandbox, Task
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
                "spec": "<what to build, precise enough to test>", "depends_on": []}}]}}
   - 2 to {max_tasks} tasks. Ids are short (T1, T2...). Each task owns exactly one module and
     no module is shared. depends_on lists task ids whose code this task calls; no cycles.
   - Prefer tasks that can run in parallel. Only add a dependency when one task calls another's code.
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
    return p


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


def qa_check(test_path: str, stack: PythonStack, bucket: dict[str, str]):
    """Tests are useful only if they run, and fail now because the code isn't written yet."""
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
- If the failing tests are right, change nothing.
End with DONE if you corrected tests, or BLOCKED: tests are correct."""


def referee_check(test_path: str, stack: PythonStack, original: str, bucket: dict[str, str]):
    """A review counts only if it changed the tests and they still pass QA's rules (run cleanly, >= 3,
    every test fails on the stub because it's unimplemented)."""
    inner = qa_check(test_path, stack, {})

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


def make_dispute(t: dict, test_path: str, stack: PythonStack, bucket: dict[str, str], engine: Engine, referee):
    def dispute(output: str) -> bool:
        if not bucket.get(test_path):
            return False
        review = Task(f"{t['id']}-review", f"Review tests for {t['title']}",
                      REFEREE_SPEC.format(module=t["module"], tid=t["id"], title=t["title"], test_path=test_path,
                                          spec=t["spec"], output=output[-3000:]),
                      [test_path], "", role="qa", merge=False, max_attempts=1, agent=referee,
                      setup_files={test_path: bucket[test_path]},
                      check=referee_check(test_path, stack, bucket[test_path], bucket))
        r = engine.run_task(review)
        if r.status == "passed":
            return True
        if r.status == "error" or (r.attempts and all(a.claim.startswith("error") for a in r.attempts)):
            return None                                  # the referee itself failed; it confirmed nothing
        return False
    return dispute


# ------------------------------------------------------------------ tasks
def tasks_from_plan(plan: dict, python_or_stack: "str | PythonStack" = "python3",
                    engine: Engine | None = None, referee=None) -> list[Task]:
    stack = python_or_stack if isinstance(python_or_stack, PythonStack) else default_stack(python_or_stack)
    by_id = {t["id"]: t for t in plan["tasks"]}
    contracts = ", ".join(plan["contracts"]) or "none"
    out = []
    for t in plan["tasks"]:
        test_path = stack.qa_test_path(t["module"])
        hidden: dict[str, str] = {}                      # filled by the QA check, read by the dev's verify
        deps = t.get("depends_on", [])
        out.append(Task(
            f"{t['id']}-qa", f"Acceptance tests for {t['title']}",
            f"Write acceptance tests for task {t['id']} ({t['title']}), module {t['module']}, in {test_path}.\n\n"
            f"Task spec: {t['spec']}\n\nThe stub {t['module']} has the signatures and doc comments; those "
            f"are the exact behavior to test. Shared contracts: {contracts}.",
            [test_path], "", role="qa", check=qa_check(test_path, stack, hidden), merge=False))
        builds_on = "".join(f"\n- {d}: {by_id[d]['module']} ({by_id[d]['title']})" for d in deps)
        out.append(Task(
            t["id"], t["title"],
            f"Implement everything in {t['module']}. The stub's signatures and doc comments are the spec; "
            f"keep the signatures exactly.\n\n{t['spec']}\n\nShared contracts (read-only): {contracts}."
            f"\n\nYou may only edit {t['module']}. If you add your own tests, they must match "
            f"{stack.dev_test_glob(t['module'])} (any other file gets your work rejected)."
            + (f"\n\nThis builds on finished, tested work already in the repo. Import and reuse it; "
               f"you cannot edit it:{builds_on}" if deps else ""),
            [t["module"], stack.dev_test_glob(t["module"])],
            stack.verify_cmd(t["module"], test_path),
            hidden_tests=hidden, depends_on=[*deps, f"{t['id']}-qa"],
            dispute=make_dispute(t, test_path, stack, hidden, engine, referee) if engine and referee else None))
    return out


# ------------------------------------------------------------- integration
INTEGRATION_SPEC = """Every feature of this project is built, tested and merged. Turn them into a working website.

Project brief and design:
{description}

Built and tested modules (read their doc comments; you cannot edit them):
{modules}

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
- Send people to the right page for their role and keep others out, using the project's server functions.
- A simple header with links to the main pages in src/app/layout.tsx, styled with the look in the brief.
- You may only edit files under src/app/, src/middleware.ts, and your own tests under tests/unit/.

Before saying DONE, run all of this and fix anything that fails:
{check}"""


def integration_check(stack: PythonStack, pages: list[str]):
    cmd = stack.integration_check_cmd(pages)

    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec(cmd, timeout=1500)
        tail = failure_excerpt(r.output)
        if r.code != 0:
            return False, "the app doesn't build, or a page is missing or fails (see the output)", tail
        return True, "", tail
    return check


def integration_task(plan: dict, description: str, stack: PythonStack, agent=None) -> Task:
    """The last task: pages, sign-in and server actions that connect every merged feature."""
    pages = [r for r in plan.get("pages", []) if isinstance(r, str)] or ["/"]
    modules = "\n".join(f"- {t['module']}: {t['title']}" for t in plan["tasks"])
    return Task("INT", "Integrate: pages, sign-in and data",
                INTEGRATION_SPEC.format(description=description.strip(), modules=modules, pages=", ".join(pages),
                                        check=stack.integration_check_cmd(pages)),
                list(stack.integration_scope), "", role="dev", agent=agent,
                depends_on=[t["id"] for t in plan["tasks"]], check=integration_check(stack, pages))


# -------------------------------------------------------------------- run
Approver = Callable[[dict], "tuple[bool, str]"]


def auto_approve(plan: dict) -> tuple[bool, str]:
    return True, "approved automatically"


def run_project(description: str, repo: Path, engine: Engine, python: str = "python3",
                parallel: int = 4, approve: Approver = auto_approve,
                stack: PythonStack | None = None, save_tests: Path | None = None,
                referee=None, integrator=None) -> tuple[dict | None, list[Result]]:
    """Plan, then pause for approval, then QA + build. `approve(plan)` returns (approved, note); in the
    app it waits for the user's click, offline it approves automatically. `referee` is the agent that settles
    test disputes; a different model from QA's, so work is never graded only by the model that wrote it."""
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
    tasks = tasks_from_plan(plan, stack, engine=engine, referee=referee)
    if stack.integration:
        tasks.append(integration_task(plan, description, stack, agent=integrator))
    try:
        results = engine.run_all(tasks, parallel=parallel)
    finally:
        if save_tests:              # keep the hidden tests for review (never merged, never shown to devs)
            for t in tasks:
                for path, body in t.hidden_tests.items():
                    dest = Path(save_tests) / path
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(body)
    return plan, [plan_result, *results]
