from datetime import timedelta

from models import LibraryError, Loan


def checkout_tool(lib, member_id, tool_id, today, days):
    if member_id not in lib.members or tool_id not in lib.tools:
        raise LibraryError("Unknown member or tool.")
    if days < 1:
        raise LibraryError("Borrow for at least one day.")
    out = [l for l in lib.loans.values() if l.returned is None]
    if any(l.tool_id == tool_id for l in out):
        raise LibraryError("That tool is already out.")
    if sum(l.member_id == member_id for l in out) >= 3:
        raise LibraryError("You already have 3 tools out.")
    loan = Loan(lib.next_loan_id(), member_id, tool_id, today, today + timedelta(days=days))
    lib.loans[loan.id] = loan
    return loan


def return_tool(lib, loan_id, today):
    loan = lib.loans.get(loan_id)
    if loan is None or loan.returned is not None:
        raise LibraryError("That loan isn't open.")
    loan.returned = today
    return loan
