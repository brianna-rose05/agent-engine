from datetime import datetime

from store import Booking, BookingError, Store


def book(store: Store, customer_id: int, pet_id: int, slot_id: int, now: datetime) -> Booking:
    slot = store.slots.get(slot_id)
    if slot is None:
        raise BookingError("That time slot doesn't exist.")
    pet = store.pets.get(pet_id)
    if pet is None or pet.customer_id != customer_id:
        raise BookingError("That pet isn't on your account.")
    if slot.starts_at <= now:
        raise BookingError("That time has already passed.")
    if any(b.slot_id == slot_id and b.status == "booked" for b in store.bookings.values()):
        raise BookingError("Someone just booked that time.")
    b = Booking(store.next_booking_id(), customer_id, pet_id, slot_id)
    store.bookings[b.id] = b
    return b
