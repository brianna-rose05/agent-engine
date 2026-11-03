from datetime import date, datetime, time, timezone

import pytest
from availability import generate_slots

UTC = timezone.utc
LA = "America/Los_Angeles"


def hm(slots, tz=LA):
    from zoneinfo import ZoneInfo
    return [s.astimezone(ZoneInfo(tz)).strftime("%H:%M") for s in slots]


def test_basic_day_with_buffer():
    s = generate_slots(date(2026, 11, 10), LA, time(9), time(12), 60, 15, [])
    assert hm(s) == ["09:00", "10:15"]                 # 11:30 would end 12:30
    assert s[0] == datetime(2026, 11, 10, 17, 0, tzinfo=UTC)
    assert all(x.utcoffset().total_seconds() == 0 for x in s)


def test_ending_exactly_at_close_is_allowed():
    s = generate_slots(date(2026, 11, 10), LA, time(9), time(11), 60, 0, [])
    assert hm(s) == ["09:00", "10:00"]


def test_break_skips_and_restarts_at_break_end():
    s = generate_slots(date(2026, 11, 10), LA, time(9), time(15), 45, 15, [(time(11, 30), time(12, 15))])
    # 9:00, 10:00, 11:00 (ends 11:45 overlaps lunch) -> 12:15, 13:15, (14:15 ends 15:00 ok)
    assert hm(s) == ["09:00", "10:00", "12:15", "13:15", "14:15"]


def test_touching_break_is_not_overlap():
    s = generate_slots(date(2026, 11, 10), LA, time(9), time(12), 60, 0, [(time(10), time(11))])
    assert hm(s) == ["09:00", "11:00"]


def test_dst_spring_forward():
    s = generate_slots(date(2026, 3, 8), LA, time(9), time(10), 60, 0, [])
    assert s == [datetime(2026, 3, 8, 16, 0, tzinfo=UTC)]          # PDT


def test_dst_fall_back():
    s = generate_slots(date(2026, 11, 1), LA, time(9), time(10), 60, 0, [])
    assert s == [datetime(2026, 11, 1, 17, 0, tzinfo=UTC)]         # PST


def test_other_timezone():
    s = generate_slots(date(2026, 7, 1), "Europe/London", time(9), time(10), 30, 0, [])
    assert s == [datetime(2026, 7, 1, 8, 0, tzinfo=UTC), datetime(2026, 7, 1, 8, 30, tzinfo=UTC)]


@pytest.mark.parametrize("args", [(0, 0), (-30, 0), (30, -5)])
def test_bad_durations(args):
    with pytest.raises(ValueError):
        generate_slots(date(2026, 11, 10), LA, time(9), time(12), *args, [])


def test_close_before_open():
    with pytest.raises(ValueError):
        generate_slots(date(2026, 11, 10), LA, time(12), time(9), 30, 0, [])
    with pytest.raises(ValueError):
        generate_slots(date(2026, 11, 10), LA, time(9), time(9), 30, 0, [])
