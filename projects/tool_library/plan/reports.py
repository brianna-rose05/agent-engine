from __future__ import annotations

from datetime import date

from models import Library  # noqa: F401


def overdue_report(lib: Library, today: date) -> list[tuple[str, str, int, int]]:
    """One row (member name, tool name, days late, fee cents) per loan not yet returned whose due
    date is before today. Fee comes from fees.late_fee_cents. Sorted most days late first; ties by
    member name."""
    raise NotImplementedError
