from datetime import datetime, timedelta

from store import Booking, Store


def reminders_due(store: Store, now: datetime) -> list[Booking]:
    lo, hi = now + timedelta(hours=23), now + timedelta(hours=25)
    due = [b for b in store.bookings.values()
           if b.status == "booked" and lo < store.slots[b.slot_id].starts_at <= hi]
    return sorted(due, key=lambda b: store.slots[b.slot_id].starts_at)
