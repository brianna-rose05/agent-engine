from datetime import date
from zoneinfo import ZoneInfo

from store import Slot, Store


def open_slots(store: Store, day: date, tz: str) -> list[Slot]:
    zone = ZoneInfo(tz)
    taken = {b.slot_id for b in store.bookings.values() if b.status == "booked"}
    return sorted((s for s in store.slots.values()
                   if s.starts_at.astimezone(zone).date() == day and s.id not in taken),
                  key=lambda s: s.starts_at)
