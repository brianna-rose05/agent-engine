from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


def generate_slots(day, tz, open_time, close_time, duration_min, buffer_min, breaks):
    if duration_min <= 0 or buffer_min < 0 or close_time <= open_time:
        raise ValueError("bad schedule")
    zone = ZoneInfo(tz)
    at = lambda t: datetime.combine(day, t)
    cur, close, dur = at(open_time), at(close_time), timedelta(minutes=duration_min)
    brk = sorted((at(a), at(b)) for a, b in breaks)
    out = []
    while cur + dur <= close:
        hit = next(((a, b) for a, b in brk if cur < b and cur + dur > a), None)
        if hit:
            cur = hit[1]
            continue
        out.append(cur.replace(tzinfo=zone).astimezone(timezone.utc))
        cur += dur + timedelta(minutes=buffer_min)
    return out
