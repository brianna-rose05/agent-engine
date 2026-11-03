from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from store import Booking, BookingError, Store


def book_recurring(store, customer_id, pet_id, first_slot_id, every_weeks, count, now, tz):
    if every_weeks < 1 or count < 1:
        raise ValueError("every_weeks and count must be at least 1")
    pet = store.pets.get(pet_id)
    if pet is None or pet.customer_id != customer_id:
        raise BookingError("That pet isn't on your account.")
    first = store.slots.get(first_slot_id)
    if first is None or first.starts_at <= now:
        raise BookingError("That time isn't available.")
    taken = lambda sid: any(b.slot_id == sid and b.status == "booked" for b in store.bookings.values())
    if taken(first_slot_id):
        raise BookingError("That time is already booked.")
    zone = ZoneInfo(tz)
    local = first.starts_at.astimezone(zone).replace(tzinfo=None)
    booked, skipped = [], []
    for k in range(count):
        target = (local + timedelta(days=7 * every_weeks * k)).replace(tzinfo=zone).astimezone(timezone.utc)
        slot = next((s for s in store.slots.values() if s.starts_at == target), None)
        if slot is None or taken(slot.id):
            skipped.append(target)
            continue
        b = Booking(store.next_booking_id(), customer_id, pet_id, slot.id)
        store.bookings[b.id] = b
        booked.append(b)
    return booked, skipped
