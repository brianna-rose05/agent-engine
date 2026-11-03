from __future__ import annotations

from datetime import date

from models import Library, LibraryError, Loan  # noqa: F401


def checkout_tool(lib: Library, member_id: int, tool_id: int, today: date, days: int) -> Loan:
    """Lend a tool: create Loan(lib.next_loan_id(), member_id, tool_id, start=today,
    due=today + days days), add it to lib.loans and return it. Raise LibraryError if the member
    or tool doesn't exist, days < 1, the tool is out (a loan with returned=None), or the member
    already has 3 loans out."""
    raise NotImplementedError


def return_tool(lib: Library, loan_id: int, today: date) -> Loan:
    """Set the loan's returned date to today and return the loan. Raise LibraryError if the loan
    doesn't exist or was already returned."""
    raise NotImplementedError
