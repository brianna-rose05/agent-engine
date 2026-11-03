from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from refunds import refund_cents

UTC = timezone.utc
START = datetime(2026, 11, 10, 17, 0, tzinfo=UTC)


@pytest.mark.parametrize("hours,expected", [
    (72, 2000), (48, 2000), (47.99, 1000), (24, 1000), (23.99, 0), (0, 0), (-5, 0),
])
def test_windows(hours, expected):
    assert refund_cents(2000, START, START - timedelta(hours=hours), False, 0) == expected


def test_half_rounds_down():
    assert refund_cents(1999, START, START - timedelta(hours=30), False, 0) == 999


def test_staff_always_full():
    assert refund_cents(2000, START, START + timedelta(hours=1), True, 0) == 2000


def test_already_refunded_subtracted_never_negative():
    assert refund_cents(2000, START, START - timedelta(days=3), False, 500) == 1500
    assert refund_cents(2000, START, START - timedelta(hours=30), False, 1500) == 0
    assert refund_cents(2000, START, START, True, 2000) == 0


def test_mixed_timezones():
    # 9:00 AM Pacific Nov 8 is exactly 48h before 17:00 UTC Nov 10
    cancelled = datetime(2026, 11, 8, 9, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
    assert refund_cents(2000, START, cancelled, False, 0) == 2000
    cancelled = datetime(2026, 11, 8, 9, 1, tzinfo=ZoneInfo("America/Los_Angeles"))
    assert refund_cents(2000, START, cancelled, False, 0) == 1000


@pytest.mark.parametrize("args", [
    (-1, START, START, False, 0), (2000, START, START, False, -1),
    (2000, START.replace(tzinfo=None), START, False, 0), (2000, START, START.replace(tzinfo=None), False, 0),
])
def test_invalid(args):
    with pytest.raises(ValueError):
        refund_cents(*args)
