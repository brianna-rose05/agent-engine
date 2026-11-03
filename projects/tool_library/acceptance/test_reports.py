from datetime import date

from models import Library, Loan, Member, Tool
from reports import overdue_report


def lib():
    l = Library({1: Member(1, "Bo"), 2: Member(2, "Ana")}, {1: Tool(1, "drill", 300), 2: Tool(2, "saw", 100)})
    l.loans = {1: Loan(1, 1, 1, date(2026, 10, 1), date(2026, 10, 30)),
               2: Loan(2, 2, 2, date(2026, 10, 1), date(2026, 10, 30)),
               3: Loan(3, 2, 1, date(2026, 9, 1), date(2026, 9, 5), returned=date(2026, 9, 20))}
    return l


def test_rows_and_order():
    assert overdue_report(lib(), date(2026, 11, 2)) == [("Ana", "saw", 3, 300), ("Bo", "drill", 3, 900)]


def test_nothing_overdue_on_due_date():
    assert overdue_report(lib(), date(2026, 10, 30)) == []


def test_most_late_first():
    l = lib()
    l.loans[2].due = date(2026, 10, 20)
    assert [r[0] for r in overdue_report(l, date(2026, 11, 2))] == ["Ana", "Bo"]
