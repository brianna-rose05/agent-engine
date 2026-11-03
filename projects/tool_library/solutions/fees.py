def late_fee_cents(loan, tool, today):
    late = ((loan.returned or today) - loan.due).days
    return 0 if late <= 0 else min(5000, late * tool.daily_fee_cents)
