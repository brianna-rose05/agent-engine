"""The benchmark is only useful if its tests are right: every hidden test must
FAIL against the untouched stub and PASS against the reference solution."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from benchmark.suite import BY_ID, HERE, build_repo, load_tasks, with_dependencies

TASKS = load_tasks()


def run_hidden(repo: Path, task) -> int:
    for path, body in task.hidden_tests.items():
        (repo / path).write_text(body)
    return subprocess.run(task.test_cmd, shell=True, cwd=repo, capture_output=True).returncode


def install(repo: Path, ids) -> None:
    for tid in ids:
        module = BY_ID[tid]["module"]
        shutil.copy(HERE / "solutions" / module, repo / module)


@pytest.mark.parametrize("task", TASKS, ids=[t.id for t in TASKS])
def test_hidden_tests_fail_on_stub(task, tmp_path):
    """Dependencies are finished (as they would be when this task starts); only this task is a stub."""
    repo = build_repo(tmp_path / "r")
    install(repo, with_dependencies([task.id]) - {task.id})
    assert run_hidden(repo, task) != 0


@pytest.mark.parametrize("task", TASKS, ids=[t.id for t in TASKS])
def test_hidden_tests_pass_on_reference(task, tmp_path):
    repo = build_repo(tmp_path / "r")
    install(repo, with_dependencies([task.id]))
    assert run_hidden(repo, task) == 0


def test_stubs_import_cleanly(tmp_path):
    """Every stub must import, or one unfinished task would break the others' test runs."""
    repo = build_repo(tmp_path / "r")
    mods = " ".join(BY_ID[t.id]["module"][:-3] for t in TASKS)
    r = subprocess.run([sys.executable, "-c", f"import {', '.join(mods.split())}"], cwd=repo, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_asking_for_a_task_brings_its_dependencies():
    assert {t.id for t in load_tasks(["D4"])} == {"D1", "D2", "D3", "D4", "B6", "B11"}
    d3 = next(t for t in load_tasks(["D3"]) if t.id == "D3")
    assert d3.depends_on == ["D1", "B6", "B11"] and "pricing.py" in d3.spec and "cannot edit" in d3.spec
