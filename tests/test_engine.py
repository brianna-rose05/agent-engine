"""End-to-end engine behavior with real git, local sandboxes, and scripted agents."""
import subprocess

import pytest

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


def test_agent_activity_is_throttled_and_keeps_the_latest_notes(tmp_path):
    """Live activity: a planner makes hundreds of tool calls; the app gets at most one event per ~10 s per
    task, carrying the latest few notes, plus the final notes when the run ends."""
    from engine.engine import ACTIVITY_EVERY_S
    from engine.events import Emitter, ListSink
    repo = build_repo(tmp_path / "r")
    clock = {"t": 0.0}

    class Chatty(ReferenceAgent):
        def run(self, task, box, attempt, feedback, progress=None):
            for t, notes in [(0, ["Reading a.py"]), (3, ["Reading b.py", "Ran ls"]), (6, ["Wrote c.py"]),
                             (ACTIVITY_EVERY_S, ["Ran pytest", "Ran pytest -x", "Edited c.py", "Ran pytest"]),
                             (ACTIVITY_EVERY_S + 2, ["Ran git status"])]:
                clock["t"] = t
                progress(notes)
            return super().run(task, box, attempt, feedback)

    sink = ListSink()
    eng = Engine(repo, Chatty(HERE / "solutions"), lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink))
    eng.clock = lambda: clock["t"]
    assert eng.run_task(load_tasks(["B1"])[0]).status == "merged"
    acts = [e for e in sink.events if e.kind == "agent_activity"]
    assert [e.data["notes"] for e in acts] == [["Reading a.py"], ["Ran pytest -x", "Edited c.py", "Ran pytest"],
                                              ["Ran git status"]]
    assert all(e.task_id == "B1" and e.data["attempt"] == 1 and e.data["note"] == e.data["notes"][-1] for e in acts)
    kinds = [e.kind for e in sink.events]
    assert kinds.index("agent_activity") > kinds.index("task_status")      # after "working"...
    assert max(i for i, k in enumerate(kinds) if k == "agent_activity") < kinds.index("attempt_finished")


def test_agents_without_a_progress_argument_still_run(tmp_path):
    """Scripted, referee and test agents take no `progress`; the engine must not pass it to them."""
    from engine.events import Emitter, ListSink
    repo = build_repo(tmp_path / "r")
    sink = ListSink()
    eng = Engine(repo, ReferenceAgent(HERE / "solutions"), lambda t, n: LocalWorktreeSandbox(repo, t.id, n),
                 events=Emitter(sink))
    assert eng.run_task(load_tasks(["B1"])[0]).status == "merged"
    assert not [e for e in sink.events if e.kind == "agent_activity"]
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


# ------------------------------------------------------------------ tech lead (docs/tech-lead.md)
BROKEN_PAYMENTS = "from store import *  # noqa\n\n# looks finished, isn't\n"


class NeverFixes:
    """A Haiku-like dev that never gets B6 right; it also adds a test file of its own (a new, untracked file)."""
    model = "haiku"

    def __init__(self, cost=0.0):
        self.seen, self.cost = [], cost

    def run(self, task, box, attempt, feedback):
        self.seen.append((attempt, feedback))
        box.write_file("payments.py", BROKEN_PAYMENTS)
        box.write_file("tests/agent_test_payments_mine.py", "def test_mine():\n    assert True\n")
        return AgentReport("done", cost_usd=self.cost)


class Stronger(ReferenceAgent):
    model = "sonnet"

    def __init__(self):
        super().__init__(HERE / "solutions")
        self.seen = []

    def run(self, task, box, attempt, feedback):
        self.seen.append((attempt, feedback))
        return super().run(task, box, attempt, feedback)


def lead_task(verdict, calls, stronger=None):
    task = load_tasks(["B6"])[0]

    def review(attempts, diff):
        calls.append((list(attempts), diff))
        if isinstance(verdict, Exception):
            raise verdict
        return verdict
    task.review_failure, task.stronger_agent = review, stronger
    return task


def lead_engine(repo, agent, budget=None):
    from engine.events import Emitter, ListSink
    sink = ListSink()
    return Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=Emitter(sink),
                  budget=budget), sink


def kinds(sink, *names):
    return [(e.kind, e.data) for e in sink.events if e.kind in names]


def test_tech_lead_retry_on_a_stronger_model_succeeds_on_attempt_4(tmp_path):
    """Pawfect build 7 ended 24/25: a feature failed its 3 tries and the owner got no explanation. Now the tech lead
    reviews it first; its retry runs on the stronger dev agent with its note, and the attempt numbers go on."""
    repo = build_repo(tmp_path / "r")
    calls, dev, strong = [], NeverFixes(), Stronger()
    verdict = {"decision": "retry", "note": "Use the deposit rule from the doc comment.", "stronger_model": True}
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(lead_task(verdict, calls, strong))
    assert r.status == "merged" and [a.n for a in r.attempts] == [1, 2, 3, 4]
    assert [s[0] for s in dev.seen] == [1, 2, 3] and [s[0] for s in strong.seen] == [4]
    fb = strong.seen[0][1]
    assert fb.startswith("Your tech lead reviewed the failed attempts: Use the deposit rule from the doc comment.")
    assert "acceptance tests failed" in fb                                   # ...plus the last failure
    assert len(calls) == 1 and [a.n for a in calls[0][0]] == [1, 2, 3]
    assert ("task_status", {"status": "reviewing", "attempt": 3}) in kinds(sink, "task_status")
    assert kinds(sink, "tech_lead_review") == [("tech_lead_review", {
        "decision": "retry", "note": "Use the deposit rule from the doc comment.", "stronger_model": True,
        "model": "sonnet"})]
    assert not kinds(sink, "escalated")
    statuses = [e.data.get("status") for e in sink.events if e.kind == "task_status"]
    assert statuses.index("reviewing") < statuses.index("working", statuses.index("reviewing"))
    assert [e.data["n"] for e in sink.events if e.kind == "attempt_finished"] == [1, 2, 3, 4]


def test_the_last_failed_diff_reaches_the_tech_lead_new_files_included(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, _ = lead_engine(repo, NeverFixes())
    eng.run_task(lead_task({"decision": "escalate", "question": "Q?"}, calls))
    attempts, diff = calls[0]
    assert "+# looks finished, isn't" in diff and "payments.py" in diff
    assert "agent_test_payments_mine.py" in diff and "+def test_mine():" in diff     # untracked, still shown
    assert "tests/test_payments.py" not in diff                                    # hidden tests never leak in
    assert attempts[-1].reason == "acceptance tests failed" and attempts[-1].test_output


def test_the_diff_for_the_tech_lead_is_capped(tmp_path):
    from engine.engine import MAX_DIFF_CHARS
    repo = build_repo(tmp_path / "r")
    calls = []

    class Huge(NeverFixes):
        def run(self, task, box, attempt, feedback):
            box.write_file("payments.py", "x = 1\n" * 5000)
            return AgentReport("done")

    eng, _ = lead_engine(repo, Huge())
    eng.run_task(lead_task({"decision": "escalate", "question": "Q?"}, calls))
    assert len(calls[0][1]) <= MAX_DIFF_CHARS and calls[0][1].endswith("(diff cut)")


def test_tech_lead_escalates_with_one_question_for_the_owner(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls, dev = [], NeverFixes()
    q = "The spec says deposits are 20% but the contract caps them at $50. Which one wins: 20%, or the $50 cap?"
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(lead_task({"decision": "escalate", "note": "Spec and contract disagree.", "question": q,
                                "stronger_model": True}, calls, Stronger()))
    assert r.status == "failed" and r.error == f"Needs you: {q}" and len(r.attempts) == 3
    assert len(dev.seen) == 3
    assert kinds(sink, "tech_lead_review") == [("tech_lead_review", {
        "decision": "escalate", "note": "Spec and contract disagree.", "question": q, "stronger_model": False})]
    assert kinds(sink, "escalated") == [("escalated", {"question": q})]
    final = [e.data for e in sink.events if e.kind == "task_status"][-1]
    assert final["status"] == "failed" and final["error"] == f"Needs you: {q}"


def test_a_long_question_still_fits_the_error():
    from engine.engine import normalize_review
    v = normalize_review({"decision": "escalate", "question": "Which? " * 100})
    assert len(f"Needs you: {v['question']}") <= 300


def test_a_retry_that_still_fails_escalates_without_a_second_review(tmp_path):
    from engine.engine import RETRY_FAILED_QUESTION
    repo = build_repo(tmp_path / "r")
    calls, dev = [], NeverFixes()
    eng, sink = lead_engine(repo, dev)
    # no stronger agent available: the same dev makes the extra tries
    r = eng.run_task(lead_task({"decision": "retry", "note": "Read the doc comment.", "stronger_model": True}, calls))
    assert r.status == "failed" and [a.n for a in r.attempts] == [1, 2, 3, 4, 5]
    assert len(calls) == 1 and [s[0] for s in dev.seen] == [1, 2, 3, 4, 5]
    assert dev.seen[3][1].startswith("Your tech lead reviewed the failed attempts: Read the doc comment.")
    assert "tech lead" not in (dev.seen[4][1] or "")                    # attempt 5 gets the usual feedback
    assert "model" not in kinds(sink, "tech_lead_review")[0][1]
    assert kinds(sink, "escalated") == [("escalated", {"question": RETRY_FAILED_QUESTION})]
    assert r.error == f"Needs you: {RETRY_FAILED_QUESTION}"[:300]
    assert len([e for e in sink.events if e.data.get("status") == "reviewing"]) == 1


def test_a_dev_already_on_sonnet_keeps_its_agent(tmp_path):
    repo = build_repo(tmp_path / "r")
    dev, strong = NeverFixes(), Stronger()
    dev.model = "sonnet"
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(lead_task({"decision": "retry", "note": "n", "stronger_model": True}, [], strong))
    assert r.status == "failed" and len(dev.seen) == 5 and not strong.seen
    assert "model" not in kinds(sink, "tech_lead_review")[0][1]


@pytest.mark.parametrize("verdict", [RuntimeError("API Error: 529 overloaded"), None, "retry",
                                     {"decision": "maybe"}, {"note": "no decision"},
                                     {"decision": "escalate", "note": "x", "tech_lead_error": True}])
def test_a_broken_tech_lead_escalates_with_tech_lead_error(tmp_path, verdict):
    from engine.engine import TECH_LEAD_FAILED_QUESTION
    repo = build_repo(tmp_path / "r")
    eng, sink = lead_engine(repo, NeverFixes())
    r = eng.run_task(lead_task(verdict, []))
    assert r.status == "failed" and r.error == f"Needs you: {TECH_LEAD_FAILED_QUESTION}" and len(r.attempts) == 3
    review = kinds(sink, "tech_lead_review")[0][1]
    assert review["decision"] == "escalate" and review["tech_lead_error"] is True
    assert review["question"] == TECH_LEAD_FAILED_QUESTION and review["stronger_model"] is False
    assert kinds(sink, "escalated") == [("escalated", {"question": TECH_LEAD_FAILED_QUESTION})]


def test_no_review_when_the_budget_is_spent(tmp_path):
    from engine.budget import Budget
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = lead_engine(repo, NeverFixes(cost=0.4), budget=Budget(1.0))
    r = eng.run_task(lead_task({"decision": "retry", "note": "n"}, calls))
    assert r.status == "stopped" and len(r.attempts) == 3 and calls == []
    assert not kinds(sink, "tech_lead_review", "escalated")
    assert not [e for e in sink.events if e.data.get("status") == "reviewing"]


def test_no_extra_attempt_when_the_review_used_up_the_budget(tmp_path):
    from engine.budget import Budget
    repo = build_repo(tmp_path / "r")
    budget = Budget(1.0)
    dev = NeverFixes(cost=0.3)

    def review(attempts, diff):
        budget.add(0.2)                     # the reviewer's own cost uses up the rest
        return {"decision": "retry", "note": "n"}

    task = load_tasks(["B6"])[0]
    task.review_failure = review
    eng, sink = lead_engine(repo, dev, budget=budget)
    r = eng.run_task(task)
    assert r.status == "stopped" and len(r.attempts) == 3 and len(dev.seen) == 3
    assert not kinds(sink, "escalated")


def test_tasks_without_a_review_hook_fail_exactly_as_before(tmp_path):
    repo = build_repo(tmp_path / "r")
    dev = NeverFixes()
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(load_tasks(["B6"])[0])
    assert r.status == "failed" and r.error == "" and len(r.attempts) == 3 and len(dev.seen) == 3
    assert not kinds(sink, "tech_lead_review", "escalated")
    assert not [e for e in sink.events if e.data.get("status") == "reviewing"]


def test_first_feedback_reaches_the_first_attempt(tmp_path):
    repo = build_repo(tmp_path / "r")
    strong = Stronger()
    task = load_tasks(["B6"])[0]
    task.first_feedback = "The project owner answered the tech lead's question: use the cap."
    eng, _ = lead_engine(repo, strong)
    assert eng.run_task(task).status == "merged"
    assert strong.seen == [(1, "The project owner answered the tech lead's question: use the cap.")]


# ------------------------------------------------------------------ code reviewer (docs/reviewer.md)
def review_task(verdicts, calls):
    """B6 with a scripted code reviewer: one verdict per review, in order (an exception is raised instead)."""
    task = load_tasks(["B6"])[0]
    left = list(verdicts)

    def review(diff, second):
        calls.append((diff, second))
        v = left.pop(0)
        if isinstance(v, Exception):
            raise v
        return v
    task.review_code = review
    return task


def statuses(sink):
    return [e.data.get("status") for e in sink.events if e.kind == "task_status"]


def test_an_approved_attempt_merges_after_its_review(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = lead_engine(repo, Stronger())
    r = eng.run_task(review_task([{"verdict": "approve", "comments": ["Clear and complete."]}], calls))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, True)]
    assert len(calls) == 1 and calls[0][1] is False
    diff = calls[0][0]
    assert "payments.py" in diff and "tests/test_payments.py" not in diff     # the dev's work, never the hidden tests
    assert kinds(sink, "code_review") == [("code_review", {"verdict": "approve", "comments": ["Clear and complete."],
                                                            "attempt": 1})]
    order = [(e.kind, e.data.get("status")) for e in sink.events
             if e.kind in ("task_status", "code_review", "attempt_finished")]
    assert order[order.index(("task_status", "checking")):] == [
        ("task_status", "checking"), ("task_status", "reviewing_code"), ("code_review", None),
        ("attempt_finished", None), ("task_status", "merging"), ("task_status", "merged")]
    assert ("task_status", {"status": "reviewing_code", "attempt": 1}) in kinds(sink, "task_status")
    assert "NotImplementedError" not in git(repo, "show", "main:payments.py")           # the work is on main


def test_changes_send_the_dev_back_with_the_comments_then_an_approval_merges(tmp_path):
    from engine.engine import REVIEW_CHANGES
    repo = build_repo(tmp_path / "r")
    calls, dev = [], Stronger()
    comments = ["The spec says a deposit is refunded on cancellation, and nothing refunds it.",
                "Security: any user can read another user's payments."]
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(review_task([{"verdict": "changes", "comments": comments},
                                  {"verdict": "approve", "comments": []}], calls))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, False), (2, True)]
    first = r.attempts[0]
    assert first.reason == REVIEW_CHANGES and first.claim == "done"
    assert all(c in first.test_output for c in comments)
    assert [c[1] for c in calls] == [False, True]                     # the second review is security-only
    fb = dev.seen[1][1]
    assert fb.startswith("Your previous attempt passed the acceptance tests, but the code reviewer")
    assert all(f"- {c}" in fb for c in comments) and "Test output" not in fb
    assert [d for _, d in kinds(sink, "code_review")] == [{"verdict": "changes", "comments": comments, "attempt": 1},
                                                          {"verdict": "approve", "comments": [], "attempt": 2}]
    finished = [e.data for e in sink.events if e.kind == "attempt_finished"]
    assert finished[0]["passed"] is False and finished[0]["reason"] == REVIEW_CHANGES
    assert comments[0] in finished[0]["output"]
    assert statuses(sink).count("reviewing_code") == 2 and statuses(sink)[-1] == "merged"


def test_a_second_changes_without_a_security_comment_approves_with_a_note(tmp_path):
    from engine.engine import SECOND_REVIEW_NOTE
    repo = build_repo(tmp_path / "r")
    eng, sink = lead_engine(repo, Stronger())
    r = eng.run_task(review_task([{"verdict": "changes", "comments": ["Deposits are never refunded."]},
                                  {"verdict": "changes", "comments": ["Rename pay() to charge()."]}], []))
    assert r.status == "merged" and [(a.n, a.passed) for a in r.attempts] == [(1, False), (2, True)]
    assert kinds(sink, "code_review")[1] == ("code_review", {
        "verdict": "approve", "comments": ["Rename pay() to charge()."], "attempt": 2, "note": SECOND_REVIEW_NOTE})


def test_a_second_changes_for_a_security_problem_still_blocks(tmp_path):
    from engine.engine import REVIEW_CHANGES
    repo = build_repo(tmp_path / "r")
    calls, dev = [], Stronger()
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(review_task([{"verdict": "changes", "comments": ["Deposits are never refunded."]},
                                  {"verdict": "changes", "comments": ["security: the API key is in payments.py."]},
                                  {"verdict": "approve", "comments": []}], calls))
    assert r.status == "merged" and [a.n for a in r.attempts] == [1, 2, 3]
    assert [a.reason for a in r.attempts] == [REVIEW_CHANGES, REVIEW_CHANGES, ""]
    assert [c[1] for c in calls] == [False, True, True]
    assert "security: the API key is in payments.py." in dev.seen[2][1]
    assert [d["verdict"] for _, d in kinds(sink, "code_review")] == ["changes", "changes", "approve"]


def test_changes_on_every_try_end_failed_and_reach_the_tech_lead(tmp_path):
    from engine.engine import REVIEW_CHANGES
    repo = build_repo(tmp_path / "r")
    lead_calls = []
    task = review_task([{"verdict": "changes", "comments": ["Security: no ownership check."]}] * 3, [])

    def lead(attempts, diff):
        lead_calls.append((attempts, diff))
        return {"decision": "escalate", "question": "Who may see a payment?"}
    task.review_failure = lead
    eng, sink = lead_engine(repo, Stronger())
    r = eng.run_task(task)
    assert r.status == "failed" and r.error == "Needs you: Who may see a payment?" and len(r.attempts) == 3
    assert [a.reason for a in lead_calls[0][0]] == [REVIEW_CHANGES] * 3
    assert "payments.py" in lead_calls[0][1]                          # the last reviewed diff
    assert "NotImplementedError" in git(repo, "show", "main:payments.py")               # never merged
    assert not kinds(sink, "dispute_resolved")


@pytest.mark.parametrize("verdict", [RuntimeError("API Error: 529 overloaded"), None, "approve",
                                     {"verdict": "maybe"}, {"verdict": "changes", "comments": []},
                                     {"review_error": True, "note": "The review didn't finish: made no changes"}])
def test_a_broken_review_approves_with_review_error(tmp_path, verdict):
    from engine.engine import REVIEW_ERROR_NOTE
    repo = build_repo(tmp_path / "r")
    eng, sink = lead_engine(repo, Stronger())
    r = eng.run_task(review_task([verdict], []))
    assert r.status == "merged" and len(r.attempts) == 1 and r.attempts[0].passed
    review = kinds(sink, "code_review")[0][1]
    assert review["verdict"] == "approve" and review["review_error"] is True and review["comments"] == []
    assert review["note"].startswith(REVIEW_ERROR_NOTE) and review["attempt"] == 1


def test_no_review_when_the_budget_is_spent_the_feature_merges_unreviewed(tmp_path):
    from engine.budget import Budget

    class Costly(Stronger):
        def run(self, task, box, attempt, feedback):
            rep = super().run(task, box, attempt, feedback)
            rep.cost_usd = 1.0
            return rep

    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = lead_engine(repo, Costly(), budget=Budget(1.0))
    r = eng.run_task(review_task([{"verdict": "changes", "comments": ["x"]}], calls))
    assert r.status == "merged" and calls == []
    assert kinds(sink, "code_review") == [("code_review", {"verdict": "approve", "comments": [], "attempt": 1,
                                                            "skipped": True})]
    assert "reviewing_code" not in statuses(sink)


def test_failing_attempts_and_tasks_without_the_hook_are_never_reviewed(tmp_path):
    repo = build_repo(tmp_path / "r")
    calls = []
    eng, sink = lead_engine(repo, NeverFixes())
    r = eng.run_task(review_task([], calls))
    assert r.status == "failed" and len(r.attempts) == 3 and calls == []      # nothing passed: nothing to review
    eng2, sink2 = lead_engine(build_repo(tmp_path / "r2"), Stronger())
    r2 = eng2.run_task(load_tasks(["B6"])[0])
    assert r2.status == "merged" and len(r2.attempts) == 1
    assert not kinds(sink, "code_review") and not kinds(sink2, "code_review")
    assert "reviewing_code" not in statuses(sink) + statuses(sink2)


def test_hidden_test_paths_are_scrubbed_from_the_reviewers_comments(tmp_path):
    repo = build_repo(tmp_path / "r")
    dev = Stronger()
    eng, sink = lead_engine(repo, dev)
    r = eng.run_task(review_task([{"verdict": "changes", "comments": [
        "Deposits are never refunded.\nSee tests/test_payments.py::test_refund for the exact case.",
        "test_payments.py expects 20%; use that.",
        "Security: the card number is logged."]},
        {"verdict": "approve", "comments": []}], []))
    assert r.status == "merged"
    fb = dev.seen[1][1]
    assert "test_payments" not in fb and "Deposits are never refunded." in fb and "card number is logged" in fb
    assert kinds(sink, "code_review")[0][1]["comments"] == ["Deposits are never refunded.",
                                                             "Security: the card number is logged."]
    assert "test_payments" not in r.attempts[0].test_output


def test_normalize_code_review():
    from engine.engine import SCRUBBED_NOTE, normalize_code_review
    v = normalize_code_review({"verdict": "changes", "comments": ["Fails tests/test_payments.py line 4"]},
                              {"tests/test_payments.py": ""})
    assert v == {"verdict": "approve", "comments": [], "note": SCRUBBED_NOTE}   # nothing left the dev may see
    many = normalize_code_review({"verdict": "approve", "comments": [f"  note   {i} " for i in range(20)]})
    assert many["comments"][0] == "note 0" and len(many["comments"]) == 8
    assert normalize_code_review({"verdict": "changes", "comments": "one string"})["comments"] == ["one string"]
