from datetime import timedelta, timezone
from reminders import reminders_due
from store import Booking

def test_window(store):
    start = store.slots[2].starts_at
    assert [b.id for b in reminders_due(store, start - timedelta(hours=24))] == [1]
    assert reminders_due(store, start - timedelta(hours=23)) == []          # exactly 23h: excluded
    assert [b.id for b in reminders_due(store, start - timedelta(hours=25))] == [1]  # exactly 25h: included
    assert reminders_due(store, start - timedelta(hours=26)) == []

def test_skips_cancelled(store):
    start = store.slots[4].starts_at
    assert reminders_due(store, start - timedelta(hours=24)) == []

def test_non_utc_now(store):
    pst = timezone(timedelta(hours=-8))
    start = store.slots[2].starts_at
    assert [b.id for b in reminders_due(store, (start - timedelta(hours=24)).astimezone(pst))] == [1]

def test_sorted(store):
    store.bookings[3] = Booking(3, 1, 1, 1)
    start = store.slots[2].starts_at
    assert [b.id for b in reminders_due(store, start - timedelta(hours=24, minutes=30))] == [3, 1]
