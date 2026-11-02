from datetime import datetime, timedelta

from store import Booking, BookingError, Store


def cancel(store: Store, booking_id: int, by_customer_id: int, now: datetime) -> Booking:
    b = store.bookings.get(booking_id)
    if b is None or b.customer_id != by_customer_id:
        raise BookingError("Booking not found.")
    if b.status == "cancelled":
        raise BookingError("This booking is already cancelled.")
    if store.slots[b.slot_id].starts_at - now < timedelta(hours=2):
        raise BookingError("Bookings can't be cancelled less than 2 hours before.")
    b.status = "cancelled"
    return b
