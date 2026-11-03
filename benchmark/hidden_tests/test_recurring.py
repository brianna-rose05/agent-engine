from datetime import datetime, timedelta, timezone

import pytest
from recurring import book_recurring
from store import Booking, BookingError, Slot

UTC = timezone.utc
TZ = "America/Los_Angeles"
# Tue Mar 2 2027 9:00 PST = 17:00 UTC. DST starts Sun Mar 14 2027, after which 9:00 PDT = 16:00 UTC.
MAR2 = datetime(2027, 3, 2, 17, 0, tzinfo=UTC)


@pytest.fixture
def weekly(store):
    store.slots[20] = Slot(20, MAR2)
    store.slots[21] = Slot(21, datetime(2027, 3, 9, 17, 0, tzinfo=UTC))
    store.slots[22] = Slot(22, datetime(2027, 3, 16, 16, 0, tzinfo=UTC))    # 9:00 PDT
    store.slots[23] = Slot(23, datetime(2027, 3, 23, 17, 0, tzinfo=UTC))    # 10:00 PDT, wrong time
    store.slots[24] = Slot(24, datetime(2027, 3, 23, 16, 0, tzinfo=UTC))    # 9:00 PDT
    store.slots[25] = Slot(25, datetime(2027, 3, 30, 16, 0, tzinfo=UTC))
    return store


def test_weekly_keeps_local_time_across_dst(weekly, now):
    made, skipped = book_recurring(weekly, 1, 1, 20, 1, 4, now, TZ)
    assert [b.slot_id for b in made] == [20, 21, 22, 24]
    assert skipped == []
    assert all(weekly.bookings[b.id] is b and b.status == "booked" for b in made)
    assert [b.id for b in made] == [3, 4, 5, 6]


def test_every_two_weeks_and_skips(weekly, now):
    weekly.bookings[3] = Booking(3, 2, 2, 22)              # Lee has Mar 16
    made, skipped = book_recurring(weekly, 1, 3, 20, 2, 3, now, TZ)
    assert [b.slot_id for b in made] == [20, 25]
    assert skipped == [datetime(2027, 3, 16, 16, 0, tzinfo=UTC)]


def test_missing_slots_are_skipped_with_utc_times(weekly, now):
    made, skipped = book_recurring(weekly, 1, 1, 20, 1, 6, now, TZ)
    assert len(made) == 5
    assert skipped == [datetime(2027, 4, 6, 16, 0, tzinfo=UTC)]
    assert skipped[0].utcoffset() == timedelta(0)


def test_cancelled_booking_does_not_block(weekly, now):
    weekly.bookings[3] = Booking(3, 2, 2, 21, status="cancelled")
    made, _ = book_recurring(weekly, 1, 1, 20, 1, 2, now, TZ)
    assert [b.slot_id for b in made] == [20, 21]


def test_validation(weekly, now):
    before = dict(weekly.bookings)
    with pytest.raises(BookingError):
        book_recurring(weekly, 1, 2, 20, 1, 2, now, TZ)            # Mochi is Lee's
    with pytest.raises(BookingError):
        book_recurring(weekly, 1, 1, 99, 1, 2, now, TZ)            # no slot
    with pytest.raises(BookingError):
        book_recurring(weekly, 1, 1, 2, 1, 2, now, TZ)             # slot 2 is booked
    with pytest.raises(BookingError):
        book_recurring(weekly, 1, 1, 20, 1, 2, MAR2, TZ)           # not in the future
    with pytest.raises(ValueError):
        book_recurring(weekly, 1, 1, 20, 0, 2, now, TZ)
    with pytest.raises(ValueError):
        book_recurring(weekly, 1, 1, 20, 1, 0, now, TZ)
    assert weekly.bookings == before
