"""A project's spending limit, enforced by the engine (not by trusting each agent's own cap).

The worker builds one from the project's limit (`budgetUsd` in Convex) and what the project had already spent
before this run (`costUsd`); the engine adds every attempt's cost as it comes back. Once the total reaches the
limit, no new task or attempt starts: running agents finish their attempt, everything not yet started ends as
"stopped", and `budget_reached {spent, budget}` is emitted once. Raising the limit and retrying picks up there.

Running agents can still overshoot a little: each is capped at what was left when it started (see `cap`), and
several may run at once."""
from __future__ import annotations

from threading import Lock
from typing import Callable

STOPPED = "stopped"                 # a task's (and a run's) status when the budget stopped it
MIN_AGENT_CAP = 0.01                # the CLI's --max-budget-usd is printed with 2 decimals; never pass 0.00


class Budget:
    def __init__(self, limit_usd: float, already_spent_usd: float = 0.0,
                 emit: Callable[..., None] | None = None):
        if limit_usd <= 0:
            raise ValueError("a budget must be above $0")
        self.limit = float(limit_usd)
        self.spent = max(0.0, float(already_spent_usd))
        self.emit = emit or (lambda *a, **k: None)
        self.stopped = False                # True once the budget kept something from starting
        self._lock = Lock()

    def set_limit(self, limit_usd: float) -> None:
        """The owner changed the limit (e.g. on the approval screen while the worker waited)."""
        if limit_usd > 0:
            with self._lock:
                self.limit = float(limit_usd)

    def add(self, cost_usd: float) -> None:
        with self._lock:
            self.spent = round(self.spent + max(0.0, float(cost_usd or 0.0)), 6)

    @property
    def remaining(self) -> float:
        with self._lock:
            return max(0.0, round(self.limit - self.spent, 6))

    @property
    def reached(self) -> bool:
        with self._lock:
            return self.spent >= self.limit

    def allows_start(self) -> bool:
        """Asked before every task and every attempt. False once the limit is reached; the first refusal emits
        `budget_reached` (once per run, however many tasks are refused)."""
        with self._lock:
            if self.spent < self.limit:
                return True
            first, self.stopped = not self.stopped, True
            spent, limit = round(self.spent, 4), self.limit
        if first:
            self.emit("budget_reached", spent=spent, budget=limit)
        return False

    def cap(self, agent_cap: float) -> float:
        """An agent's own per-attempt cap, lowered to what is left of the project's budget."""
        return max(MIN_AGENT_CAP, min(float(agent_cap), self.remaining))

    def reason(self) -> str:
        return f"stopped at the project's spending limit (${self.spent:.2f} of ${self.limit:.2f})"
