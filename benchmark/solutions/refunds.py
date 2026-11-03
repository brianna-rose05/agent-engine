from datetime import datetime, timedelta


def refund_cents(deposit_paid_cents, slot_start, cancelled_at, by_staff, already_refunded_cents):
    if deposit_paid_cents < 0 or already_refunded_cents < 0:
        raise ValueError("amounts can't be negative")
    if slot_start.utcoffset() is None or cancelled_at.utcoffset() is None:
        raise ValueError("datetimes need a timezone")
    if by_staff:
        due = deposit_paid_cents
    else:
        ahead = slot_start - cancelled_at
        if ahead >= timedelta(hours=48):
            due = deposit_paid_cents
        elif ahead >= timedelta(hours=24):
            due = deposit_paid_cents // 2
        else:
            due = 0
    return max(0, due - already_refunded_cents)
