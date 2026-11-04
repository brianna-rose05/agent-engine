from __future__ import annotations

from datetime import date

from models import Library, LibraryError, Loan  # noqa: F401


def renew_loan(lib: Library, loan_id: int, today: date, days: int) -> Loan:
    """Extend an open loan: loan.due becomes loan.due + days days; return the loan. Raise LibraryError if the
    loan doesn't exist or was already returned, days < 1, or the loan owes a late fee today
    (fees.late_fee_cents(loan, its tool, today) > 0)."""
    raise NotImplementedError
