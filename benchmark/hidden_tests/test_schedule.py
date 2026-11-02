from datetime import date
from schedule import daily_schedule
from store import Booking

def test_format_and_cancelled_skipped(store):
    assert daily_schedule(store, date(2026, 11, 10), "America/Los_Angeles") == ["10:00 AM  Mochi (Shiba Inu) - Lee"]

def test_sorted_and_no_leading_zero(store):
    store.bookings[3] = Booking(3, 1, 1, 6)   # 2 PM
    store.bookings[4] = Booking(4, 1, 3, 1)   # 9 AM
    assert daily_schedule(store, date(2026, 11, 10), "America/Los_Angeles") == [
        "9:00 AM  Pepper (Poodle) - Dana",
        "10:00 AM  Mochi (Shiba Inu) - Lee",
        "2:00 PM  Biscuit (Golden Retriever) - Dana",
    ]

def test_other_day_and_tz(store):
    assert daily_schedule(store, date(2026, 11, 12), "America/Los_Angeles") == []
    assert daily_schedule(store, date(2026, 11, 11), "Asia/Tokyo") == ["3:00 AM  Mochi (Shiba Inu) - Lee"]
