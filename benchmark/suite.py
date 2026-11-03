"""Benchmark suite: builds a fresh starter repo and turns tasks.json into engine Tasks."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from engine.interfaces import Task

HERE = Path(__file__).parent
TASKS = json.loads((HERE / "tasks.json").read_text())
IMPORTS = ("from __future__ import annotations\n\nfrom datetime import date, datetime  # noqa: F401\n\n"
           "from store import Booking, BookingError, Slot, Store  # noqa: F401\n")
BY_ID = {t["id"]: t for t in TASKS}


def stub(t: dict) -> str:
    if t.get("kind") == "contract":                  # the architect fills this in; nothing to call yet
        return f'"""{t["spec"]}"""\n' + IMPORTS
    body = f'    """{t["spec"]}"""\n    raise NotImplementedError\n'
    return IMPORTS + "\n" + "\n\n".join(f"\n{sig}:\n{body}" for sig in t["signature"].splitlines()) + "\n"


def build_repo(dest: Path) -> Path:
    """Fresh git repo: data model + shared fixtures + one stub per task. Hidden tests stay out."""
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(HERE / "app", dest)
    for t in TASKS:
        (dest / t["module"]).write_text(stub(t))
    (dest / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n")
    (dest / "AGENTS.md").write_text(
        "# Team rules\n- Python 3.11+, standard library only.\n- Do not change store.py or tests/conftest.py (locked contract).\n"
        "- Raise BookingError with a short, customer-friendly message.\n- You may add your own tests as tests/agent_test_<module>.py.\n")
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "engine@local"],
                ["git", "config", "user.name", "engine"], ["git", "add", "-A"],
                ["git", "commit", "-qm", "scaffold: data model, fixtures, task stubs"]):
        subprocess.run(cmd, cwd=dest, check=True, capture_output=True)
    return dest


def with_dependencies(ids: list[str]) -> set[str]:
    """Asking for D4 means also running what D4 is built on."""
    want, stack = set(), list(ids)
    while stack:
        tid = stack.pop()
        if tid not in want:
            want.add(tid)
            stack.extend(BY_ID[tid].get("depends_on", []))
    return want


def builds_on(t: dict) -> str:
    deps = t.get("depends_on", [])
    if not deps:
        return ""
    lines = "\n".join(f"- {d}: {BY_ID[d]['module']} ({BY_ID[d]['title']})" for d in deps)
    return ("\n\nThis builds on finished, tested work that is already in the repo. Read it, import it, "
            f"and use it as is. You cannot edit it:\n{lines}")


def load_tasks(only: list[str] | None = None, python: str = "python3") -> list[Task]:
    """`python` is the interpreter *inside the sandbox*: plain python3 in the cloud,
    this machine's interpreter for local sandboxes."""
    want = with_dependencies(only) if only else None
    out = []
    for t in TASKS:
        if want is not None and t["id"] not in want:
            continue
        mod = t["module"][:-3]
        test_path = f"tests/test_{mod}.py"
        out.append(Task(
            id=t["id"], title=t["title"],
            spec=(f"Write the shared types in {t['module']}.\n\n{t['spec']}" if t.get("kind") == "contract"
                  else f"Implement `{t['signature']}` in {t['module']}.\n\n{t['spec']}") + builds_on(t),
            can_edit=[t["module"], f"tests/agent_test_{mod}*.py"],
            test_cmd=f"{python} -m pytest -q -p no:cacheprovider {test_path}",
            hidden_tests={test_path: (HERE / "hidden_tests" / f"test_{mod}.py").read_text()},
            depends_on=list(t.get("depends_on", [])),
        ))
    return out
