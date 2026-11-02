"""The benchmark is only useful if its tests are right: every hidden test must
FAIL against the untouched stub and PASS against the reference solution."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from benchmark.suite import HERE, build_repo, load_tasks

TASKS = load_tasks()


def run_hidden(repo: Path, task) -> int:
    for path, body in task.hidden_tests.items():
        (repo / path).write_text(body)
    return subprocess.run(task.test_cmd, shell=True, cwd=repo, capture_output=True).returncode


@pytest.mark.parametrize("task", TASKS, ids=[t.id for t in TASKS])
def test_hidden_tests_fail_on_stub(task, tmp_path):
    assert run_hidden(build_repo(tmp_path / "r"), task) != 0


@pytest.mark.parametrize("task", TASKS, ids=[t.id for t in TASKS])
def test_hidden_tests_pass_on_reference(task, tmp_path):
    repo = build_repo(tmp_path / "r")
    module = task.can_edit[0]
    shutil.copy(HERE / "solutions" / module, repo / module)
    assert run_hidden(repo, task) == 0
