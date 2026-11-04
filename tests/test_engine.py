"""End-to-end engine behavior with real git, local sandboxes, and scripted agents."""
import subprocess

from benchmark.suite import HERE, build_repo, load_tasks
from engine.agents.scripted import ReferenceAgent, SloppyAgent
from engine.engine import Engine
from engine.interfaces import AgentReport, SandboxLost, SandboxUnavailable
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
    # Everything that did merge still passes its hidden tests on main (they're never committed there)
    merged = [t for t in load_tasks() if results[t.id].status == "merged"]
    for t in merged:
        for path, body in t.hidden_tests.items():
            (repo / path).write_text(body)
    paths = [p for t in merged for p in t.hidden_tests]
    assert subprocess.run(["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", *paths], cwd=repo).returncode == 0


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


def test_agent_error_is_the_reason_not_made_no_changes(tmp_path):
    """Regression (Pawfect build): API errors showed up as "made no changes", hiding the real cause."""
    repo = build_repo(tmp_path / "r")

    class Broken:
        def run(self, task, box, attempt, feedback):
            return AgentReport("error: agent run did not finish (API Error: 529 overloaded)")

    r = engine(repo, Broken()).run_task(load_tasks(["B1"])[0])
    assert r.status == "failed"
    assert r.attempts[0].reason == "agent run did not finish (API Error: 529 overloaded)"


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


def test_hidden_tests_never_reach_main(tmp_path):
    """Regression (milestone 3): hidden tests were written into the sandbox for verification and
    then committed with the agent's work, so later agents could read them on main."""
    repo = build_repo(tmp_path / "r")
    results = engine(repo, ReferenceAgent(HERE / "solutions")).run_all(load_tasks(["B1", "B6"]), parallel=2)
    assert all(r.status == "merged" for r in results)
    files = git(repo, "ls-tree", "-r", "--name-only", "main").split()
    assert "tests/test_slots.py" not in files and "tests/test_payments.py" not in files
    assert "slots.py" in files


def test_feedback_shows_the_failure_not_just_the_summary():
    """Regression (first web run): Vitest prints the expected/received diff before a long code frame
    and summary; keeping only the last 15 lines dropped the diff, so the agent retried blind."""
    from engine.engine import failure_excerpt
    out = "\n".join(["noise"] * 40 + [" FAIL  tests/a.test.ts > dogs", "AssertionError: expected { ownerId: 'x' } to match object { owner_id: 'x' }",
                     "- Expected", "+ Received", "-   owner_id: 'x'", "+   ownerId: 'x'"] + ["  code frame"] * 30 +
                    [" Tests  1 failed | 45 passed (46)"])
    ex = failure_excerpt(out)
    assert "owner_id" in ex and "ownerId" in ex and "45 passed" in ex and "noise\nnoise\nnoise\nnoise" not in ex


def test_sandbox_capacity_errors_wait_and_retry(tmp_path):
    """Spec: provider outages retry with backoff instead of failing the task. Regression: the first web
    run hit Daytona's 10 GB account limit and marked 8 tasks as errors."""
    repo = build_repo(tmp_path / "r")
    tries, naps = [], []

    class Flaky(LocalWorktreeSandbox):
        def __enter__(self):
            tries.append(1)
            if len(tries) < 3:
                raise SandboxUnavailable("Failed to create sandbox: Total memory limit exceeded. Maximum allowed: 10GiB.")
            return super().__enter__()

    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: Flaky(repo, t.id, n))
    eng.sleep = naps.append
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "merged" and naps == [30, 60] and len(r.attempts) == 1


def test_provider_gateway_errors_are_retried_too(tmp_path):
    """Regression (third web run): a Daytona 502 while starting the planner's sandbox ended the project."""
    repo = build_repo(tmp_path / "r")
    tries = []

    class Gateway(LocalWorktreeSandbox):
        def __enter__(self):
            tries.append(1)
            if len(tries) == 1:
                raise SandboxUnavailable("DaytonaBadGatewayError: Failed to create sandbox: Failure during waiting for sandbox to start")
            return super().__enter__()

    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: Gateway(repo, t.id, n))
    eng.sleep = lambda s: None
    assert eng.run_task(load_tasks(["B6"])[0]).status == "merged" and len(tries) == 2


def test_non_capacity_setup_errors_fail_fast(tmp_path):
    repo = build_repo(tmp_path / "r")

    class Broken(LocalWorktreeSandbox):
        def __enter__(self):
            raise RuntimeError("sandbox setup failed on `npm ci`: ERESOLVE")

    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: Broken(repo, t.id, n))
    eng.sleep = lambda s: (_ for _ in ()).throw(AssertionError("should not wait"))
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "error" and "npm ci" in r.error


def test_local_git_errors_are_not_treated_as_provider_outages(tmp_path):
    """Regression: treating every sandbox error as an outage turned a local git error into a long wait."""
    repo = build_repo(tmp_path / "r")

    class GitBroken(LocalWorktreeSandbox):
        def __enter__(self):
            raise RuntimeError("fatal: could not create work tree dir")

    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: GitBroken(repo, t.id, n))
    eng.sleep = lambda s: (_ for _ in ()).throw(AssertionError("should not wait"))
    assert eng.run_task(load_tasks(["B6"])[0]).status == "error"


# ------------------------------------------------------------- infrastructure failures mid-attempt
class Drops(LocalWorktreeSandbox):
    """A sandbox whose connection drops during the agent's work, `drops` times in all."""
    left = 0
    opened: list = []

    def __enter__(self):
        Drops.opened.append(self.branch)
        return super().__enter__()

    def write_file(self, path, content):
        if Drops.left:
            Drops.left -= 1
            raise SandboxLost("DaytonaError: Remote end closed connection without response")
        super().write_file(path, content)


def drop_engine(repo, drops, sink):
    from engine.events import Emitter
    Drops.left, Drops.opened = drops, []
    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: Drops(repo, t.id, n), events=Emitter(sink))
    naps = []
    eng.sleep = naps.append
    return eng, naps


def test_a_dropped_sandbox_mid_attempt_is_redone_in_a_fresh_one(tmp_path):
    """Regression (Daytona build): "Remote end closed connection" in the middle of an attempt ended the task as
    "error" and blocked everything after it. A lost sandbox is the provider's fault: open a fresh one and redo
    that attempt, without using up one of the agent's tries, and tell the app why it's taking longer."""
    from engine.events import ListSink
    repo = build_repo(tmp_path / "r")
    sink = ListSink()
    eng, naps = drop_engine(repo, 1, sink)
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "merged" and r.first_pass and [a.n for a in r.attempts] == [1]
    assert Drops.opened == ["task/B6-a1", "task/B6-a1"] and naps == [10]
    lost = [e.data for e in sink.events if e.data.get("status") == "sandbox_lost"]
    assert len(lost) == 1 and lost[0]["retry"] == 1 and "Remote end closed" in lost[0]["error"]
    assert "B6" in git(repo, "log", "--oneline", "main")


def test_a_sandbox_that_keeps_dropping_errors_after_two_retries(tmp_path):
    from engine.events import ListSink
    repo = build_repo(tmp_path / "r")
    eng, naps = drop_engine(repo, 99, ListSink())
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "error" and "SandboxLost" in r.error and not r.attempts
    assert len(Drops.opened) == 3 and naps == [10, 30]          # the first try plus two fresh sandboxes


def test_infra_retries_are_per_task_not_per_attempt(tmp_path):
    """The agent's own failed tries still count as usual; a drop on a later try is redone under the same number."""
    from engine.events import ListSink
    repo = build_repo(tmp_path / "r")

    class SloppyThenDrop(Drops):
        def write_file(self, path, content):
            if self.branch.endswith("-a2") and Drops.left:
                Drops.left -= 1
                raise SandboxLost("DaytonaConnectionError: connection reset")
            LocalWorktreeSandbox.write_file(self, path, content)

    from engine.events import Emitter
    Drops.left, Drops.opened = 1, []
    eng = Engine(repo, SloppyAgent(HERE / "solutions"), lambda t, n: SloppyThenDrop(repo, t.id, n),
                 events=Emitter(ListSink()))
    eng.sleep = lambda s: None
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "merged" and [a.n for a in r.attempts] == [1, 2] and not r.attempts[0].passed
    assert Drops.opened == ["task/B6-a1", "task/B6-a2", "task/B6-a2"]


def test_other_errors_mid_attempt_still_stop_at_once(tmp_path):
    """Only a lost sandbox is retried. A bug or a broken environment would fail the same way again."""
    repo = build_repo(tmp_path / "r")

    class Buggy(LocalWorktreeSandbox):
        def write_file(self, path, content):
            raise KeyError("a bug in our own code")

    opened = []
    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: (opened.append(n), Buggy(repo, t.id, n))[1])
    eng.sleep = lambda s: (_ for _ in ()).throw(AssertionError("should not wait"))
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "error" and "KeyError" in r.error and opened == [1]


def test_setup_errors_mid_attempt_are_not_retried(tmp_path):
    repo = build_repo(tmp_path / "r")
    task = load_tasks(["B6"])[0]
    task.test_cmd = "definitely-not-a-command"                        # exit 127: the checks can't run
    eng = engine(repo, ReferenceAgent(HERE / "solutions"))
    eng.sleep = lambda s: (_ for _ in ()).throw(AssertionError("should not wait"))
    r = eng.run_task(task)
    assert r.status == "error" and "SetupError" in r.error


# ------------------------------------------------------------- git on the shared repo
def test_parallel_worktrees_never_trip_over_each_other(tmp_path):
    """Regression (CI flakes in test_project): `git worktree add` and `remove` running in parallel race on
    .git/worktrees itself ("could not create directory of '.git/worktrees/T1-a1'", "failed to read
    .git/worktrees/T2-a1/gitdir"); no .lock file is involved, so the old retry missed it and the task
    ended as "error". Every change to the shared repo now goes through one lock."""
    from concurrent.futures import ThreadPoolExecutor
    repo = build_repo(tmp_path / "r")

    def churn(k):
        errors = []
        for i in range(40):
            try:
                with LocalWorktreeSandbox(repo, f"W{k}", i) as box:
                    box.write_file(f"w{k}.txt", str(i))
            except Exception as e:
                errors.append(str(e))
        return errors

    with ThreadPoolExecutor(8) as pool:
        errors = [e for errs in pool.map(churn, range(8)) for e in errs]
    assert errors == []
    assert git(repo, "worktree", "list").count("\n") == 1                 # only the main checkout is left


def test_merges_and_worktree_changes_take_turns(tmp_path):
    """A merge into main and a sandbox being created or removed never run at the same time."""
    import threading
    import time
    from engine.gitlock import repo_lock
    repo = build_repo(tmp_path / "r")
    eng = engine(repo, ReferenceAgent(HERE / "solutions"))
    with LocalWorktreeSandbox(repo, "B6", 1) as box:
        box.write_file("note.txt", "x")
        box.publish("note")
        done = []
        with repo_lock(repo):
            t = threading.Thread(target=lambda: done.append(eng.merge(box.branch, "B6")))
            t.start()
            time.sleep(0.5)
            assert not done                                              # waiting for the lock
            u = threading.Thread(target=lambda: done.append(LocalWorktreeSandbox(repo, "X", 1).__enter__().branch))
            u.start()
            time.sleep(0.3)
            assert not done
        t.join(10)
        u.join(10)
    assert sorted(done) == ["merged", "task/X-a1"]


def test_a_failed_commit_is_an_error_not_a_silent_merge(tmp_path):
    """publish ignored a failed `git commit`, so the unchanged branch merged as "merged" with none of the
    work on main. It raises now; an agent that committed its own work still publishes fine."""
    import pytest
    repo = build_repo(tmp_path / "r")
    with LocalWorktreeSandbox(repo, "B6", 1) as box:
        box.write_file("a.txt", "1")
        box.exec("git add -A && git commit -qm 'agent committed it'")
        box.publish("nothing left to commit")                              # fine
        box.write_file("b.txt", "2")
        box.exec("git config core.hooksPath hooks && mkdir -p hooks && printf '#!/bin/sh\\nexit 1\\n' > hooks/pre-commit"
                 " && chmod +x hooks/pre-commit")
        with pytest.raises(RuntimeError, match="commit failed"):
            box.publish("blocked by a hook")
