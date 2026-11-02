from datetime import datetime

from store import Booking, BookingError, Store


def reschedule(store: Store, booking_id: int, new_slot_id: int, by_customer_id: int, now: datetime) -> Booking:
    b = store.bookings.get(booking_id)
    if b is None or b.customer_id != by_customer_id or b.status != "booked":
        raise BookingError("Booking not found.")
    if new_slot_id == b.slot_id:
        raise BookingError("That's already your time.")
    slot = store.slots.get(new_slot_id)
    if slot is None or slot.starts_at <= now:
        raise BookingError("That time isn't available.")
    if any(o.slot_id == new_slot_id and o.status == "booked" and o.id != b.id for o in store.bookings.values()):
        raise BookingError("That time is taken.")
    b.slot_id = new_slot_id
    return b
