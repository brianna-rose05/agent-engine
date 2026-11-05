"""The project spending limit (engine/budget.py): the guard itself, the Engine stopping work at the limit, the CLI
agent's cap and the worker's final status."""
import threading
from types import SimpleNamespace

import pytest

from benchmark.suite import HERE, build_repo, load_tasks
from engine.agents.claude_cli import ClaudeCLIAgent
from engine.agents.scripted import ReferenceAgent
from engine.budget import Budget
from engine.engine import Engine, Result
from engine.events import Emitter, ListSink
from engine.interfaces import AgentReport, Task
from engine.sandboxes.local_worktree import LocalWorktreeSandbox


def emitted():
    calls = []
    return calls, lambda kind, task_id=None, **data: calls.append((kind, data))


# ------------------------------------------------------------------ the guard
def test_guard_counts_what_was_spent_before_this_run():
    calls, emit = emitted()
    b = Budget(5.0, already_spent_usd=4.5, emit=emit)
    assert b.allows_start() and b.remaining == 0.5
    b.add(0.3)
    assert b.allows_start() and not b.reached
    b.add(0.2)
    assert b.reached and b.remaining == 0.0
    assert not b.allows_start() and not b.allows_start()
    assert calls == [("budget_reached", {"spent": 5.0, "budget": 5.0})]       # once, however many refusals
    assert b.stopped


def test_guard_never_emits_when_nothing_was_refused():
    calls, emit = emitted()
    b = Budget(1.0, emit=emit)
    b.add(2.0)                       # the last running agent overshot, but nothing else wanted to start
    assert calls == [] and not b.stopped


def test_guard_caps_an_agent_at_what_is_left():
    b = Budget(1.0, 0.7)
    assert b.cap(0.5) == pytest.approx(0.3)
    assert b.cap(0.1) == 0.1                           # its own cap when that is lower
    b.add(5)
    assert b.cap(0.5) == 0.01                          # never 0.00, which the CLI would read as no budget at all


def test_guard_rejects_a_zero_budget_and_ignores_negative_costs():
    with pytest.raises(ValueError):
        Budget(0)
    b = Budget(1.0)
    b.add(-3)
    b.add(None)
    assert b.spent == 0


def test_guard_is_safe_across_threads():
    b = Budget(1000.0)
    threads = [threading.Thread(target=lambda: [b.add(0.01) for _ in range(500)]) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert b.spent == pytest.approx(40.0)


# ------------------------------------------------------------------ engine
class Costly(ReferenceAgent):
    """Writes the reference solution and reports a fixed cost per attempt."""

    def __init__(self, cost: float, fail_first: tuple[str, ...] = ()):
        super().__init__(HERE / "solutions")
        self.cost, self.fail_first, self.ran = cost, set(fail_first), []

    def run(self, task, box, attempt, feedback):
        self.ran.append((task.id, attempt))
        if task.id in self.fail_first and attempt == 1:
            box.write_file(task.can_edit[0], "# broken\n")
            return AgentReport("done", cost_usd=self.cost)
        super().run(task, box, attempt, feedback)
        return AgentReport("done", cost_usd=self.cost)


def make(repo, agent, budget):
    sink = ListSink()
    events = Emitter(sink)
    b = Budget(budget[0], budget[1], events.emit) if budget else None
    return Engine(repo, agent, lambda t, n: LocalWorktreeSandbox(repo, t.id, n), events=events, budget=b), sink


def test_budget_stops_later_tasks_and_downstream_ones_are_stopped_not_blocked(tmp_path):
    repo = build_repo(tmp_path / "r")
    agent = Costly(0.40)
    eng, sink = make(repo, agent, (1.00, 0.10))       # $0.10 spent before this run
    # serial, so the order is fixed: D1 (0.50 total), D2 (0.90 total), then B1 starts (still under) -> 1.30
    tasks = load_tasks(["D1", "D2", "B1", "B2", "B3"])
    order = {"D1": 0, "D2": 1, "B1": 2, "B2": 3, "B3": 4}
    tasks.sort(key=lambda t: order[t.id])
    for prev, t in zip(tasks, tasks[1:]):             # chain them so they run one after another
        t.depends_on = sorted({*t.depends_on, prev.id})
    res = {r.task: r for r in eng.run_all(tasks, parallel=1)}
    assert [res[t].status for t in ("D1", "D2", "B1")] == ["merged"] * 3
    assert res["B2"].status == res["B3"].status == "stopped"
    assert "spending limit" in res["B2"].error and not res["B2"].attempts
    assert [k for k, _ in agent.ran] == ["D1", "D2", "B1"]
    reached = [e for e in sink.events if e.kind == "budget_reached"]
    assert len(reached) == 1 and reached[0].data == {"spent": 1.3, "budget": 1.0}
    statuses = [(e.task_id, e.data["status"]) for e in sink.events if e.kind == "task_status"]
    assert ("B2", "stopped") in statuses and ("B3", "stopped") in statuses
    assert not any(s == "blocked" for _, s in statuses)


def test_running_task_finishes_but_gets_no_new_attempt(tmp_path):
    """A task already running when the limit is reached finishes its attempt (and merges if it passes); a task
    whose attempt failed gets no retry. Both run alongside the task that spends the last of the budget."""
    repo = build_repo(tmp_path / "r")
    gate = threading.Event()

    class Agent(Costly):
        def run(self, task, box, attempt, feedback):
            if task.id == "B1":                       # spends the whole budget while B2 and B3 are mid-attempt
                super().run(task, box, attempt, feedback)
                threading.Timer(0.5, gate.set).start()
                return AgentReport("done", cost_usd=1.0)
            gate.wait(10)
            return super().run(task, box, attempt, feedback)

    agent = Agent(0.20, fail_first=("B3",))
    eng, sink = make(repo, agent, (1.00, 0.0))
    res = {r.task: r for r in eng.run_all(load_tasks(["B1", "B2", "B3", "B4"]), parallel=3)}
    assert res["B1"].status == "merged"
    assert res["B2"].status == "merged"               # was running: finished and merged
    assert res["B3"].status == "stopped" and len(res["B3"].attempts) == 1   # failed try 1, no try 2
    assert res["B4"].status == "stopped" and not res["B4"].attempts
    assert sum(1 for e in sink.events if e.kind == "budget_reached") == 1


def test_engine_without_a_budget_is_unchanged(tmp_path):
    repo = build_repo(tmp_path / "r")
    eng, sink = make(repo, Costly(100.0), None)
    assert all(r.status == "merged" for r in eng.run_all(load_tasks(["B1", "B2"]), parallel=2))
    assert not any(e.kind == "budget_reached" for e in sink.events)


def test_review_tasks_count_toward_the_budget(tmp_path):
    """Referee and confirmation reviews run through engine.run_task, so their costs count like any other."""
    repo = build_repo(tmp_path / "r")
    eng, _ = make(repo, Costly(0.25), (10.0, 0.0))
    eng.run_task(load_tasks(["B1"])[0])
    review = Task("B1-review", "Review", "", ["slots.py"], "true", role="qa", merge=False, max_attempts=1,
                  agent=Costly(0.5), check=lambda box: (True, "", ""))
    eng.run_task(review)
    assert eng.budget.spent == pytest.approx(0.75)


def test_engine_passes_what_is_left_to_agents_that_take_a_cap(tmp_path):
    repo = build_repo(tmp_path / "r")
    seen = []

    class Capped(Costly):
        def run(self, task, box, attempt, feedback, budget_cap=None):
            seen.append(budget_cap)
            return super().run(task, box, attempt, feedback)

    eng, _ = make(repo, Capped(0.0), (2.0, 1.25))
    eng.run_task(load_tasks(["B1"])[0])
    assert seen == [pytest.approx(0.75)]


def test_cli_agent_lowers_its_cap_to_the_remaining_budget():
    task = load_tasks(["B1"])[0]
    agent = ClaudeCLIAgent(api_key="sk-test-123", budget_usd=0.50)
    assert "--max-budget-usd 0.50" in agent.command(task, None)
    assert "--max-budget-usd 0.20" in agent.command(task, None, budget_cap=0.2)
    assert "--max-budget-usd 0.50" in agent.command(task, None, budget_cap=3.0)
    assert "--max-budget-usd 0.01" in agent.command(task, None, budget_cap=0.0)


# ------------------------------------------------------------------ worker
def test_worker_finishes_stopped_when_the_budget_stopped_work():
    from worker import finished, project_budget
    assert finished([Result("PLAN", "p", "merged"), Result("T1", "a", "merged"), Result("T2", "b", "stopped")]) == "stopped"
    assert finished([Result("T1", "a", "failed"), Result("INT", "i", "stopped")]) == "stopped"
    assert finished([Result("T1", "a", "stopped"), Result("INT", "i", "merged")]) == "done"
    assert finished([Result("T1", "a", "failed"), Result("T2", "b", "blocked")]) == "failed"
    b = project_budget({"budgetUsd": 12, "costUsd": 3.5}, lambda *a, **k: None)
    assert (b.limit, b.spent) == (12.0, 3.5)
    assert project_budget({}, None).limit == 5.0


def test_cli_agent_run_forwards_the_cap():
    task = load_tasks(["B1"])[0]
    commands = []

    def exec_(cmd, timeout=None, env=None):
        commands.append(cmd)
        return SimpleNamespace(code=0, output='{"type": "result", "subtype": "success", "result": "done", '
                                              '"total_cost_usd": 0.1, "num_turns": 2}')

    ClaudeCLIAgent(api_key="sk-test-123", budget_usd=1.0).run(task, SimpleNamespace(exec=exec_), 1, None, budget_cap=0.33)
    assert "--max-budget-usd 0.33" in commands[0]


def test_worker_uses_the_limit_as_it_stands_when_the_owner_decides():
    from worker import with_fresh_budget
    b = Budget(5.0, 4.0)
    rows = iter([{"budgetUsd": 20}, None])
    approve = with_fresh_budget(lambda plan: (True, "ok"), lambda: next(rows), b)
    assert approve({}) == (True, "ok") and b.limit == 20.0
    assert approve({}) == (True, "ok") and b.limit == 20.0        # no row: keep the limit we have
