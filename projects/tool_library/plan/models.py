"""Shared contract for the tool library. Every task builds on these types."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class Member:
    id: int
    name: str


@dataclass
class Tool:
    id: int
    name: str
    daily_fee_cents: int


@dataclass
class Loan:
    id: int
    member_id: int
    tool_id: int
    start: date
    due: date
    returned: date | None = None


@dataclass
class Library:
    members: dict[int, Member] = field(default_factory=dict)
    tools: dict[int, Tool] = field(default_factory=dict)
    loans: dict[int, Loan] = field(default_factory=dict)

    def next_loan_id(self) -> int:
        return max(self.loans, default=0) + 1


class LibraryError(Exception):
    """A lending rule was broken. The message is shown to the member."""
