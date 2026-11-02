from datetime import timedelta
import pytest
from cancel import cancel
from store import BookingError

def test_owner_cancels(store, now):
    assert cancel(store, 1, 2, now).status == "cancelled"

def test_other_customer_cannot(store, now):
    with pytest.raises(BookingError):
        cancel(store, 1, 1, now)
    assert store.bookings[1].status == "booked"

def test_already_cancelled(store, now):
    with pytest.raises(BookingError):
        cancel(store, 2, 1, now)

def test_unknown(store, now):
    with pytest.raises(BookingError):
        cancel(store, 99, 1, now)

def test_two_hour_rule(store):
    start = store.slots[2].starts_at
    with pytest.raises(BookingError):
        cancel(store, 1, 2, start - timedelta(hours=1, minutes=59))
    assert cancel(store, 1, 2, start - timedelta(hours=2)).status == "cancelled"
