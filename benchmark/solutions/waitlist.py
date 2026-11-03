from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from store import Booking, Store


@dataclass
class WaitlistEntry:
    customer_id: int
    pet_id: int
    day: date
    order: int


def join_waitlist(waitlist, customer_id, pet_id, day):
    for e in waitlist:
        if (e.customer_id, e.pet_id, e.day) == (customer_id, pet_id, day):
            raise ValueError("already on the waitlist for that day")
    e = WaitlistEntry(customer_id, pet_id, day, max((x.order for x in waitlist), default=0) + 1)
    waitlist.append(e)
    return e


def promote_from_waitlist(store: Store, waitlist, slot_id, tz, now: datetime):
    slot = store.slots.get(slot_id)
    if slot is None or slot.starts_at <= now:
        return None
    if any(b.slot_id == slot_id and b.status == "booked" for b in store.bookings.values()):
        return None
    zone = ZoneInfo(tz)
    local_day = slot.starts_at.astimezone(zone).date()
    for e in sorted(waitlist, key=lambda x: x.order):
        if e.day != local_day:
            continue
        pet = store.pets.get(e.pet_id)
        if pet is None or pet.customer_id != e.customer_id:
            continue
        busy = any(b.customer_id == e.customer_id and b.status == "booked" and b.slot_id in store.slots
                   and store.slots[b.slot_id].starts_at.astimezone(zone).date() == local_day
                   for b in store.bookings.values())
        if busy:
            continue
        b = Booking(store.next_booking_id(), e.customer_id, e.pet_id, slot_id)
        store.bookings[b.id] = b
        waitlist.remove(e)
        return b
    return None
