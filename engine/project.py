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

from engine.engine import Engine, GraphError, Result, SetupError, check_graph
from engine.interfaces import Sandbox, Task

MAX_TASKS = 10
MIN_QA_TESTS = 3
MODULE_RE = re.compile(r"^[a-z_][a-z0-9_]*\.py$")
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")
RESERVED = {"conftest.py", "setup.py", "plan.py"}

PLAN_GUIDE = """Plan this project so a team of AI agents can build it in parallel.

Write these files at the top level of the repo (no folders):

1. plan.json, exactly this shape:
   {{"project": "<name>",
     "contracts": ["models.py"],
     "tasks": [{{"id": "T1", "title": "<short>", "module": "lending.py",
                "spec": "<what to build, precise enough to test>", "depends_on": []}}]}}
   - 2 to {max_tasks} tasks. Ids are short (T1, T2...). Each task owns exactly one module and
     no module is shared. depends_on lists task ids whose code this task calls; no cycles.
   - Prefer tasks that can run in parallel. Only add a dependency when one task calls another's code.
2. Every contract file in full: the shared dataclasses and exception types all tasks use.
   Contracts hold types only, no business logic.
3. A stub for every task module: imports, then each public function with type hints, a docstring
   stating exactly what it returns and when it raises, and a body of `raise NotImplementedError`.
   Docstrings are the spec QA tests against, so pin down edge cases, rounding and ordering.

Use Python 3.11+ standard library only. Every file must import cleanly.

Project description:
{description}"""


# ------------------------------------------------------------------- repo
def build_project_repo(dest: Path) -> Path:
    """An empty project repo: team rules and test config, nothing else."""
    import shutil
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    (dest / "AGENTS.md").write_text(
        "# Team rules\n- Python 3.11+, standard library only. Top-level modules, no packages.\n"
        "- Contract files listed in plan.json are shared and read-only after planning.\n"
        "- Raise the project's error types with short, user-friendly messages.\n"
        "- Dev agents may add their own tests as tests/test_<module>*.py.\n")
    (dest / "pytest.ini").write_text("[pytest]\npythonpath = .\n")
    (dest / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n")
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "engine@local"],
                ["git", "config", "user.name", "engine"], ["git", "add", "-A"],
                ["git", "commit", "-qm", "empty project"]):
        subprocess.run(cmd, cwd=dest, check=True, capture_output=True)
    return dest


# ------------------------------------------------------------------- plan
def plan_problems(plan) -> list[str]:
    """Everything wrong with a plan's structure, in words a planner can act on."""
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
        if not MODULE_RE.match(c) or c in RESERVED:
            p.append(f"contract {c!r} must be a top-level snake_case .py file")
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
        if not isinstance(mod, str) or not MODULE_RE.match(mod) or mod in RESERVED:
            p.append(f"{tid}: module {mod!r} must be a top-level snake_case .py file")
        elif mod in owners:
            p.append(f"{tid}: module {mod} is already owned by {owners[mod]}; each module has one owner")
        else:
            owners[mod] = tid
        deps = t.get("depends_on", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            p.append(f"{tid}: depends_on must be a list of task ids")
    if p:
        return p
    try:
        check_graph([Task(t["id"], t["title"], "", [], "", depends_on=t.get("depends_on", [])) for t in tasks])
    except GraphError as e:
        p.append(str(e))
    return p


def plan_check(python: str):
    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec("cat plan.json")
        if r.code:
            return False, "plan.json is missing", ""
        try:
            plan = json.loads(r.output)
        except json.JSONDecodeError as e:
            return False, f"plan.json is not valid JSON ({e})", ""
        if problems := plan_problems(plan):
            return False, "the plan has problems: " + "; ".join(problems), ""
        changed = box.exec("git diff --name-only $(git merge-base HEAD main); "
                           "git ls-files --others --exclude-standard").output.split()
        if nested := [f for f in changed if "/" in f]:
            return False, f"planning files must be top-level; remove {', '.join(nested)}", ""
        modules = [t["module"] for t in plan["tasks"]]
        expected = set(modules) | set(plan["contracts"]) | {"plan.json"}
        if extra := sorted(set(changed) - expected):
            return False, f"files not named in plan.json: {', '.join(extra)}", ""
        if missing := [f for f in sorted(expected) if box.exec(f"test -f {shlex.quote(f)}").code]:
            return False, f"plan.json names files that don't exist: {', '.join(missing)}", ""
        names = ", ".join(m[:-3] for m in plan["contracts"] + modules)
        imp = box.exec(f"{python} -c {shlex.quote('import ' + names)}")
        if imp.code in (126, 127):
            raise SetupError(f"python could not run in the sandbox: {imp.output[-300:]}")
        if imp.code:
            return False, "the stubs and contracts don't import cleanly", imp.output[-1500:]
        if unstubbed := [m for m in modules if box.exec(f"grep -q NotImplementedError {shlex.quote(m)}").code]:
            return False, f"task modules must be stubs (raise NotImplementedError): {', '.join(unstubbed)}", ""
        return True, "", f"plan OK: {len(modules)} tasks"
    return check


def planning_task(description: str, python: str) -> Task:
    return Task("PLAN", "Plan the project", PLAN_GUIDE.format(description=description.strip(), max_tasks=MAX_TASKS),
                ["*"], "", role="planner", check=plan_check(python))


# --------------------------------------------------------------------- QA
def summary_counts(output: str) -> dict[str, int]:
    tail = "\n".join(output.strip().splitlines()[-3:])
    return {k: int(n) for n, k in re.findall(r"(\d+) (passed|failed|errors?)", tail)}


def qa_check(test_path: str, python: str, bucket: dict[str, str]):
    """Tests are useful only if they run, and fail now because the code isn't written yet."""
    def check(box: Sandbox) -> tuple[bool, str, str]:
        r = box.exec(f"{python} -m pytest -q -p no:cacheprovider {shlex.quote(test_path)}")
        tail = "\n".join(r.output.strip().splitlines()[-15:])
        if r.code in (126, 127) or "No module named pytest" in r.output:
            raise SetupError(f"test command could not run (exit {r.code}): {tail[-300:]}")
        n = summary_counts(r.output)
        errors = n.get("error", 0) + n.get("errors", 0)
        if r.code in (2, 3, 4, 5) or errors:
            return False, "the tests don't run cleanly (import, syntax or fixture errors)", tail
        if n.get("passed"):
            return False, (f"{n['passed']} test(s) already pass against the unimplemented stub, so they "
                           "check nothing; every test must exercise the behavior"), tail
        if n.get("failed", 0) < MIN_QA_TESTS:
            return False, f"write at least {MIN_QA_TESTS} tests", tail
        if "NotImplementedError" not in r.output:
            return False, "the tests fail, but not because the code is unimplemented; check imports and setup", tail
        body = box.exec(f"cat {shlex.quote(test_path)}")
        bucket.clear()
        bucket[test_path] = body.output
        return True, "", tail
    return check


# ------------------------------------------------------------------ tasks
def tasks_from_plan(plan: dict, python: str = "python3") -> list[Task]:
    by_id = {t["id"]: t for t in plan["tasks"]}
    contracts = ", ".join(plan["contracts"]) or "none"
    out = []
    for t in plan["tasks"]:
        mod = t["module"][:-3]
        test_path = f"acceptance/test_{mod}.py"
        hidden: dict[str, str] = {}                      # filled by the QA check, read by the dev's verify
        deps = t.get("depends_on", [])
        out.append(Task(
            f"{t['id']}-qa", f"Acceptance tests for {t['title']}",
            f"Write acceptance tests for task {t['id']} ({t['title']}), module {t['module']}, in {test_path}.\n\n"
            f"Task spec: {t['spec']}\n\nThe stub {t['module']} has the signatures and docstrings; those "
            f"docstrings are the exact behavior to test. Shared types are in: {contracts}.",
            [test_path], "", role="qa", check=qa_check(test_path, python, hidden), merge=False))
        builds_on = "".join(f"\n- {d}: {by_id[d]['module']} ({by_id[d]['title']})" for d in deps)
        out.append(Task(
            t["id"], t["title"],
            f"Implement every function in {t['module']}. The stub's signatures and docstrings are the spec; "
            f"keep the signatures exactly.\n\n{t['spec']}\n\nShared types (read-only): {contracts}."
            + (f"\n\nThis builds on finished, tested work already in the repo. Import and reuse it; "
               f"you cannot edit it:{builds_on}" if deps else ""),
            [t["module"], f"tests/test_{mod}*.py"],
            f"{python} -m pytest -q -p no:cacheprovider {test_path}",
            hidden_tests=hidden, depends_on=[*deps, f"{t['id']}-qa"]))
    return out


# -------------------------------------------------------------------- run
def run_project(description: str, repo: Path, engine: Engine, python: str = "python3",
                parallel: int = 4) -> tuple[dict | None, list[Result]]:
    planner = planning_task(description, python)
    plan_result = engine.run_task(planner)
    if plan_result.status != "merged":
        return None, [plan_result]
    plan = json.loads((Path(repo) / "plan.json").read_text())
    tasks = tasks_from_plan(plan, python)
    return plan, [plan_result, *engine.run_all(tasks, parallel=parallel)]
