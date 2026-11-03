from datetime import date

from fees import late_fee_cents
from models import Loan, Tool

T = Tool(1, "drill", 300)


def loan(returned=None):
    return Loan(1, 1, 1, date(2026, 11, 1), date(2026, 11, 5), returned)


def test_not_late():
    assert late_fee_cents(loan(), T, date(2026, 11, 5)) == 0


def test_late_uses_return_date():
    assert late_fee_cents(loan(date(2026, 11, 7)), T, date(2026, 12, 1)) == 600
    assert late_fee_cents(loan(), T, date(2026, 11, 8)) == 900


def test_cap():
    assert late_fee_cents(loan(), T, date(2027, 1, 1)) == 5000
