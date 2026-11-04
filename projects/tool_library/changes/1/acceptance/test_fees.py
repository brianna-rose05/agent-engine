from datetime import date

from fees import late_fee_cents
from models import Loan, Tool

T = Tool(1, "drill", 300)


def loan(returned=None):
    return Loan(1, 1, 1, date(2026, 11, 1), date(2026, 11, 5), returned)


def test_not_late():                       # unchanged behavior: passes before and after the change
    assert late_fee_cents(loan(), T, date(2026, 11, 5)) == 0


def test_first_day_late_is_free():
    assert late_fee_cents(loan(), T, date(2026, 11, 6)) == 0


def test_fee_starts_on_the_second_day_late():
    assert late_fee_cents(loan(date(2026, 11, 8)), T, date(2026, 12, 1)) == 600
    assert late_fee_cents(loan(), T, date(2026, 11, 7)) == 300


def test_cap():                            # unchanged behavior
    assert late_fee_cents(loan(), T, date(2027, 1, 1)) == 5000
