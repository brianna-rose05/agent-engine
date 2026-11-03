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

from engine.engine import Engine, GraphError, Result, SetupError, check_graph
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
        if problems := plan_problems(plan, stack):
            return False, "the plan has problems: " + "; ".join(problems), ""
        changed = box.exec("git diff --name-only $(git merge-base HEAD main); "
                           "git ls-files --others --exclude-standard").output.split()
        if not stack.nested_files_ok and (nested := [f for f in changed if "/" in f]):
            return False, f"planning files must be top-level; remove {', '.join(nested)}", ""
        modules = [t["module"] for t in plan["tasks"]]
        expected = set(modules) | set(plan["contracts"]) | {"plan.json"}
        if extra := sorted(set(changed) - expected):
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
        body = box.exec(f"cat {shlex.quote(test_path)}")
        bucket.clear()
        bucket[test_path] = body.output
        return True, "", tail
    return check


# ------------------------------------------------------------------ tasks
def tasks_from_plan(plan: dict, python_or_stack: "str | PythonStack" = "python3") -> list[Task]:
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
            + (f"\n\nThis builds on finished, tested work already in the repo. Import and reuse it; "
               f"you cannot edit it:{builds_on}" if deps else ""),
            [t["module"], stack.dev_test_glob(t["module"])],
            stack.verify_cmd(t["module"], test_path),
            hidden_tests=hidden, depends_on=[*deps, f"{t['id']}-qa"]))
    return out


# -------------------------------------------------------------------- run
Approver = Callable[[dict], "tuple[bool, str]"]


def auto_approve(plan: dict) -> tuple[bool, str]:
    return True, "approved automatically"


def run_project(description: str, repo: Path, engine: Engine, python: str = "python3",
                parallel: int = 4, approve: Approver = auto_approve,
                stack: PythonStack | None = None) -> tuple[dict | None, list[Result]]:
    """Plan, then pause for approval, then QA + build. `approve(plan)` returns (approved, note); in the
    app it waits for the user's click, offline it approves automatically."""
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
    tasks = tasks_from_plan(plan, stack)
    return plan, [plan_result, *engine.run_all(tasks, parallel=parallel)]
