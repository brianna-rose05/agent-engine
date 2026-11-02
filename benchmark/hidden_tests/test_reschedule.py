import pytest
from reschedule import reschedule
from store import Booking, BookingError

def test_moves_same_booking(store, now):
    b = reschedule(store, 1, 5, 2, now)
    assert b.id == 1 and b.slot_id == 5 and len(store.bookings) == 2

def test_target_taken(store, now):
    store.bookings[3] = Booking(3, 1, 1, 5)
    with pytest.raises(BookingError):
        reschedule(store, 1, 5, 2, now)

def test_target_previously_cancelled_is_ok(store, now):
    assert reschedule(store, 1, 4, 2, now).slot_id == 4

def test_not_owner_or_cancelled(store, now):
    with pytest.raises(BookingError):
        reschedule(store, 1, 5, 1, now)
    with pytest.raises(BookingError):
        reschedule(store, 2, 5, 1, now)

def test_same_slot_unknown_slot_past_slot(store, now):
    with pytest.raises(BookingError):
        reschedule(store, 1, 2, 2, now)
    with pytest.raises(BookingError):
        reschedule(store, 1, 99, 2, now)
    with pytest.raises(BookingError):
        reschedule(store, 1, 5, 2, store.slots[5].starts_at)
    assert store.bookings[1].slot_id == 2
