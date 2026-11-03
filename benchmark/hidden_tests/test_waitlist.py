from datetime import date, timedelta

import pytest
from store import Booking, Customer, Pet
from waitlist import join_waitlist, promote_from_waitlist

TZ = "America/Los_Angeles"
NOV10, NOV11 = date(2026, 11, 10), date(2026, 11, 11)


def test_join_orders_and_rejects_duplicates():
    wl = []
    a = join_waitlist(wl, 1, 1, NOV10)
    b = join_waitlist(wl, 2, 2, NOV10)
    assert (a.order, b.order) == (1, 2) and wl == [a, b]
    with pytest.raises(ValueError):
        join_waitlist(wl, 1, 1, NOV10)
    c = join_waitlist(wl, 1, 1, NOV11)           # different day is fine
    assert c.order == 3


def test_order_keeps_increasing_after_removal():
    wl = []
    join_waitlist(wl, 1, 1, NOV10)
    b = join_waitlist(wl, 1, 3, NOV10)
    wl.pop(0)
    assert join_waitlist(wl, 2, 2, NOV10).order == b.order + 1


def test_promotes_earliest_eligible(store, now):
    wl = []
    join_waitlist(wl, 2, 2, NOV10)               # Lee already has a booking that day -> skipped
    dana = join_waitlist(wl, 1, 3, NOV10)
    bk = promote_from_waitlist(store, wl, 4, TZ, now)   # slot 4: only a cancelled booking
    assert bk is not None and (bk.customer_id, bk.pet_id, bk.slot_id, bk.status) == (1, 3, 4, "booked")
    assert store.bookings[bk.id] is bk and bk.id == 3
    assert dana not in wl and len(wl) == 1


def test_day_is_local_not_utc(store, now):
    # slot 6 starts 14:00 PST Nov 10 = 22:00 UTC; add one at 17:30 PST Nov 10 = 01:30 UTC Nov 11
    from store import Slot
    store.slots[9] = Slot(9, store.slots[1].starts_at + timedelta(hours=8, minutes=30))
    wl = []
    join_waitlist(wl, 1, 1, NOV11)
    assert promote_from_waitlist(store, wl, 9, TZ, now) is None and len(wl) == 1
    join_waitlist(wl, 1, 1, NOV10)
    bk = promote_from_waitlist(store, wl, 9, TZ, now)
    assert bk.slot_id == 9 and [e.day for e in wl] == [NOV11]


def test_skips_pet_not_owned(store, now):
    wl = []
    join_waitlist(wl, 1, 2, NOV10)               # Mochi is Lee's
    assert promote_from_waitlist(store, wl, 4, TZ, now) is None and len(wl) == 1


def test_no_promotion_when_taken_missing_or_past(store, now):
    wl = []
    join_waitlist(wl, 1, 1, NOV10)
    before = dict(store.bookings)
    assert promote_from_waitlist(store, wl, 2, TZ, now) is None          # booked by Lee
    assert promote_from_waitlist(store, wl, 99, TZ, now) is None         # no such slot
    later = store.slots[4].starts_at + timedelta(minutes=1)
    assert promote_from_waitlist(store, wl, 4, TZ, later) is None        # already started
    assert len(wl) == 1 and store.bookings == before


def test_customer_with_cancelled_booking_that_day_is_eligible(store, now):
    wl = []
    join_waitlist(wl, 1, 1, NOV10)               # Dana's only Nov 10 booking is cancelled
    assert promote_from_waitlist(store, wl, 5, TZ, now).customer_id == 1


def test_other_day_booking_does_not_block(store, now):
    store.bookings[3] = Booking(3, 1, 1, 7)      # Dana booked Nov 11
    wl = []
    join_waitlist(wl, 1, 3, NOV10)
    assert promote_from_waitlist(store, wl, 1, TZ, now).id == 4
