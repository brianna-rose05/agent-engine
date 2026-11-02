from datetime import date
from slots import open_slots

def test_excludes_booked_includes_cancelled(store):
    ids = [s.id for s in open_slots(store, date(2026, 11, 10), "America/Los_Angeles")]
    assert 2 not in ids and 4 in ids

def test_only_that_local_day_sorted(store):
    ids = [s.id for s in open_slots(store, date(2026, 11, 10), "America/Los_Angeles")]
    assert 7 not in ids
    starts = [store.slots[i].starts_at for i in ids]
    assert starts == sorted(starts)
    assert set(ids) == {1, 3, 4, 5, 6, 8}

def test_timezone_shifts_day(store):
    # 9 AM-2 PM Pacific on Nov 10 is 2 AM-7 AM Nov 11 in Tokyo
    assert open_slots(store, date(2026, 11, 10), "Asia/Tokyo") == []
    assert len(open_slots(store, date(2026, 11, 11), "Asia/Tokyo")) == 6

def test_empty_day(store):
    assert open_slots(store, date(2026, 12, 25), "America/Los_Angeles") == []
