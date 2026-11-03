from __future__ import annotations

from datetime import date

from models import Loan, Tool  # noqa: F401


def late_fee_cents(loan: Loan, tool: Tool, today: date) -> int:
    """Days late = (loan.returned, or today if not returned) minus loan.due, in days. If that is
    0 or less the fee is 0. Otherwise days late * tool.daily_fee_cents, capped at 5000."""
    raise NotImplementedError
