from datetime import timedelta

import fees
from models import LibraryError


def renew_loan(lib, loan_id, today, days):
    loan = lib.loans.get(loan_id)
    if loan is None or loan.returned is not None:
        raise LibraryError("That loan isn't open.")
    if days < 1:
        raise LibraryError("Renew for at least one day.")
    if fees.late_fee_cents(loan, lib.tools[loan.tool_id], today) > 0:
        raise LibraryError("This loan is late: please return it first.")
    loan.due = loan.due + timedelta(days=days)
    return loan
