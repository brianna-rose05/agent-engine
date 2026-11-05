"""Milestone 2: tasks run as a dependency graph. A task starts only after its dependencies have
merged, so its sandbox contains their code; failures block everything downstream."""
import subprocess
import threading
import time

import pytest

from engine.engine import Engine, GraphError, check_graph
from engine.interfaces import AgentReport, Task
from engine.sandboxes.local_worktree import LocalWorktreeSandbox


def make_repo(path):
    path.mkdir()
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"],
                ["git", "config", "user.name", "t"], ["git", "commit", "-q", "--allow-empty", "-m", "init"]):
        subprocess.run(cmd, cwd=path, check=True, capture_output=True)
    return path


def task(tid, deps=(), check=None):
    """Each task writes <id>.txt. Its acceptance check also requires its dependencies' files to
    exist in the sandbox, which is only true if they merged before this task started."""
    files = [f"{d}.txt" for d in deps] + [f"{tid}.txt"]
    return Task(tid, f"task {tid}", "write the file", [f"{tid}.txt"],
                check or " && ".join(f"test -f {f}" for f in files), depends_on=list(deps))


class Writer:
    def __init__(self, fail=(), delay=0.0):
        self.fail, self.delay, self.log, self.lock = set(fail), delay, [], threading.Lock()

    def run(self, t, box, attempt, feedback):
        with self.lock:
            self.log.append(("start", t.id, time.time()))
        time.sleep(self.delay)
        if t.id not in self.fail:                    # a failing agent writes nothing -> rejected
            box.write_file(f"{t.id}.txt", t.id)
        with self.lock:
            self.log.append(("end", t.id, time.time()))
        return AgentReport("done")


def run(tmp_path, tasks, agent, parallel=4):
    repo = make_repo(tmp_path / "r")
    eng = Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), max_attempts=1)
    return {r.task: r for r in eng.run_all(tasks, parallel=parallel)}, repo


def test_dependents_see_merged_code_from_dependencies(tmp_path):
    # diamond: A -> (B, C) -> D
    tasks = [task("D", ["B", "C"]), task("B", ["A"]), task("C", ["A"]), task("A")]
    res, _ = run(tmp_path, tasks, Writer())
    assert all(r.status == "merged" for r in res.values()), {k: (r.status, r.attempts) for k, r in res.items()}


def test_independent_tasks_still_run_in_parallel(tmp_path):
    agent = Writer(delay=1.0)
    res, _ = run(tmp_path, [task("A"), task("B"), task("C")], agent, parallel=3)
    assert all(r.status == "merged" for r in res.values())
    # 3 x 1s tasks, not run one after another: every task starts before any of them ends. Regression (CI): a
    # wall-clock limit (< 2.8s for the whole run) failed on a slow runner whose git work took 3.5s.
    when = {(kind, tid): ts for kind, tid, ts in agent.log}
    assert max(when[("start", t)] for t in "ABC") < min(when[("end", t)] for t in "ABC")


def test_dependent_does_not_start_before_dependency_merges(tmp_path):
    agent = Writer(delay=0.5)
    run(tmp_path, [task("B", ["A"]), task("A")], agent)
    when = {(kind, tid): ts for kind, tid, ts in agent.log}
    assert when[("start", "B")] > when[("end", "A")]


def test_failure_blocks_everything_downstream(tmp_path):
    tasks = [task("A"), task("B", ["A"]), task("C", ["B"]), task("X")]
    agent = Writer(fail={"A"})
    res, repo = run(tmp_path, tasks, agent)
    assert res["A"].status == "failed"
    assert res["B"].status == "blocked" and "A" in res["B"].error
    assert res["C"].status == "blocked" and "B" in res["C"].error
    assert res["X"].status == "merged"
    started = {tid for kind, tid, _ in agent.log if kind == "start"}
    assert started == {"A", "X"}                     # never spent money on doomed tasks
    assert res["B"].attempts == [] and res["B"].cost_usd == 0


def test_results_keep_input_order(tmp_path):
    tasks = [task("C", ["B"]), task("B", ["A"]), task("A")]
    res, _ = run(tmp_path, tasks, Writer())
    assert list(res) == ["C", "B", "A"]


@pytest.mark.parametrize("tasks,msg", [
    ([task("A", ["Z"])], "Z, which is not in this run"),
    ([task("A", ["B"]), task("B", ["A"])], "cycle"),
    ([task("A", ["A"])], "cycle"),
    ([task("A"), task("A")], "duplicate"),
])
def test_broken_plans_are_rejected_before_any_work(tasks, msg):
    with pytest.raises(GraphError, match=msg):
        check_graph(tasks)


def test_engine_rejects_broken_plan_without_starting_agents(tmp_path):
    agent = Writer()
    with pytest.raises(GraphError):
        run(tmp_path, [task("A", ["B"]), task("B", ["A"])], agent)
    assert agent.log == []
