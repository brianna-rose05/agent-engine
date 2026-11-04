def late_fee_cents(loan, tool, today):
    """Days late = (loan.returned, or today if not returned) minus loan.due, in days. The first day late is
    free: if days late is 1 or less the fee is 0. Otherwise (days late - 1) * tool.daily_fee_cents, capped at
    5000."""
    late = ((loan.returned or today) - loan.due).days
    return 0 if late <= 0 else min(5000, late * tool.daily_fee_cents)
