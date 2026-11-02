import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from store import Booking, Customer, Pet, Slot, Store  # noqa: E402

UTC = timezone.utc
# Nov 10 2026, Pacific time is UTC-8. 17:00 UTC == 9:00 AM local.
DAY_START_UTC = datetime(2026, 11, 10, 17, 0, tzinfo=UTC)


@pytest.fixture
def store() -> Store:
    s = Store()
    s.customers = {1: Customer(1, "Dana", "dana@example.com"), 2: Customer(2, "Lee", "lee@example.com")}
    s.pets = {1: Pet(1, 1, "Biscuit", "Golden Retriever"), 2: Pet(2, 2, "Mochi", "Shiba Inu"),
              3: Pet(3, 1, "Pepper", "Poodle")}
    # 6 hourly slots, 9 AM to 2 PM Pacific on Nov 10, plus one on Nov 11 at 9 AM
    s.slots = {i + 1: Slot(i + 1, DAY_START_UTC + timedelta(hours=i)) for i in range(6)}
    s.slots[7] = Slot(7, DAY_START_UTC + timedelta(days=1))
    s.slots[8] = Slot(8, DAY_START_UTC + timedelta(hours=2), price_cents=0)  # free nail trim
    s.bookings = {1: Booking(1, 2, 2, 2), 2: Booking(2, 1, 1, 4, status="cancelled")}
    return s


@pytest.fixture
def now() -> datetime:
    return DAY_START_UTC - timedelta(days=1)   # Nov 9, 9:00 AM Pacific
