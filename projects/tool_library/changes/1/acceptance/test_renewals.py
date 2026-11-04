from datetime import date

import pytest
from models import Library, LibraryError, Loan, Member, Tool
from renewals import renew_loan


@pytest.fixture
def lib():
    lib = Library({1: Member(1, "Ana")}, {1: Tool(1, "drill", 300)})
    lib.loans[1] = Loan(1, 1, 1, date(2026, 11, 1), date(2026, 11, 5))
    return lib


def test_renew_extends_the_due_date(lib):
    loan = renew_loan(lib, 1, date(2026, 11, 4), 7)
    assert loan is lib.loans[1] and loan.due == date(2026, 11, 12)


def test_one_day_late_owes_nothing_so_it_can_be_renewed(lib):
    assert renew_loan(lib, 1, date(2026, 11, 6), 2).due == date(2026, 11, 7)


def test_refused_when_a_fee_is_owed_or_the_loan_is_closed(lib):
    with pytest.raises(LibraryError):
        renew_loan(lib, 1, date(2026, 11, 7), 2)
    with pytest.raises(LibraryError):
        renew_loan(lib, 9, date(2026, 11, 4), 2)
    with pytest.raises(LibraryError):
        renew_loan(lib, 1, date(2026, 11, 4), 0)
    lib.loans[1].returned = date(2026, 11, 4)
    with pytest.raises(LibraryError):
        renew_loan(lib, 1, date(2026, 11, 4), 2)
