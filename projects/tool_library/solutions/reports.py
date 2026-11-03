import fees


def overdue_report(lib, today):
    rows = []
    for loan in lib.loans.values():
        if loan.returned is None and loan.due < today:
            tool = lib.tools[loan.tool_id]
            rows.append((lib.members[loan.member_id].name, tool.name, (today - loan.due).days,
                         fees.late_fee_cents(loan, tool, today)))
    return sorted(rows, key=lambda r: (-r[2], r[0]))
