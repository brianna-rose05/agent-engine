"""End-to-end engine behavior with real git, local sandboxes, and scripted agents."""
import subprocess

from benchmark.suite import HERE, build_repo, load_tasks
from engine.agents.scripted import ReferenceAgent, SloppyAgent
from engine.engine import Engine
from engine.interfaces import AgentReport
from engine.sandboxes.local_worktree import LocalWorktreeSandbox


def engine(repo, agent):
    return Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n))


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


def test_reference_agent_merges_everything_first_try(tmp_path):
    repo = build_repo(tmp_path / "r")
    results = engine(repo, ReferenceAgent(HERE / "solutions")).run_all(load_tasks(), parallel=4)
    assert all(r.status == "merged" and r.first_pass for r in results)
    assert git(repo, "status", "--short") == ""


def test_sloppy_agent_is_caught_and_main_stays_clean(tmp_path):
    repo = build_repo(tmp_path / "r")
    agent = SloppyAgent(HERE / "solutions", never_fix=("B6",), cheat_on=("B3",))
    results = {r.task: r for r in engine(repo, agent).run_all(load_tasks(), parallel=4)}
    assert results["B6"].status == "failed" and len(results["B6"].attempts) == 3
    assert "outside its scope: store.py" in results["B3"].attempts[0].reason
    # D3 needs B6 (deposit) and D4 needs D3, so both are blocked instead of attempted
    assert results["D3"].status == results["D4"].status == "blocked" and not results["D4"].attempts
    attempted = [r for r in results.values() if r.status != "blocked"]
    # B6 fails all 3 tries; every other attempted task (including the cheater, B3) fails its first try silently
    assert sum(r.silent_failures for r in results.values()) == 3 + (len(attempted) - 1)
    assert "locked" in git(repo, "show", "main:store.py")                # cheat never reached main
    assert "NotImplementedError" in git(repo, "show", "main:payments.py")   # failed task never merged
    assert subprocess.run(["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=repo).returncode == 0


def test_slow_task_not_blamed_for_files_merged_by_others(tmp_path):
    """Regression: main moves while a task runs; other tasks' merged files must not count as its edits."""
    import time
    repo = build_repo(tmp_path / "r")

    class Slow(ReferenceAgent):
        def run(self, task, box, attempt, feedback):
            if task.id == "B1":
                time.sleep(2)
            return super().run(task, box, attempt, feedback)

    results = engine(repo, Slow(HERE / "solutions")).run_all(load_tasks(["B1", "B2", "B3"]), parallel=3)
    assert all(r.first_pass for r in results), [(r.task, [a.reason for a in r.attempts]) for r in results]


def test_agent_that_changes_nothing_is_rejected(tmp_path):
    repo = build_repo(tmp_path / "r")

    class Lazy:
        def run(self, task, box, attempt, feedback):
            return AgentReport("done")

    r = engine(repo, Lazy()).run_task(load_tasks(["B1"])[0])
    assert r.status == "failed" and r.attempts[0].reason == "made no changes"


def test_feedback_from_failure_reaches_next_attempt(tmp_path):
    repo = build_repo(tmp_path / "r")
    seen = []

    class Recorder(SloppyAgent):
        def run(self, task, box, attempt, feedback):
            seen.append(feedback)
            return super().run(task, box, attempt, feedback)

    engine(repo, Recorder(HERE / "solutions")).run_task(load_tasks(["B2"])[0])
    assert seen[0] is None and "acceptance tests failed" in seen[1] and "Test output" in seen[1]


def test_unrunnable_test_command_is_a_setup_error_not_agent_failure(tmp_path):
    """Regression (first Daytona run): tests were launched with this Mac's Python path, which
    didn't exist in the sandbox. Every attempt 'failed', retries were wasted, and 24 false
    silent failures were recorded. Now it stops at once and reports a setup error."""
    repo = build_repo(tmp_path / "r")
    calls = []

    class Counting(ReferenceAgent):
        def run(self, task, box, attempt, feedback):
            calls.append(attempt)
            return super().run(task, box, attempt, feedback)

    task = load_tasks(["B6"], python="/Users/someone/.venv/bin/python3")[0]   # path missing here
    r = engine(repo, Counting(HERE / "solutions")).run_task(task)
    assert r.status == "error" and "could not run" in r.error
    assert calls == [1] and r.silent_failures == 0                          # no wasted retries


def test_cloud_tasks_use_the_sandbox_python():
    assert load_tasks(["B1"], python="python3")[0].test_cmd.startswith("python3 -m pytest")


def test_infra_crash_is_reported_not_hidden(tmp_path):
    repo = build_repo(tmp_path / "r")

    class Boom:
        def run(self, task, box, attempt, feedback):
            raise ConnectionError("sandbox lost")

    r = engine(repo, Boom()).run_task(load_tasks(["B1"])[0])
    assert r.status == "error" and "sandbox lost" in r.error
