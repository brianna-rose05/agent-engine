import csv
import io
from zoneinfo import ZoneInfo

from store import Customer, Store


def _valid_tz(name):
    try:
        ZoneInfo(name)
        return True
    except Exception:
        return False


def import_customers(store, csv_text):
    text = csv_text.lstrip("﻿")
    rows = list(csv.reader(io.StringIO(text)))
    out = {"added": 0, "updated": 0, "skipped": []}
    if not rows:
        return out
    header = [h.strip().lower() for h in rows[0]]
    col = {name: header.index(name) for name in ("name", "email", "timezone") if name in header}
    by_email = {c.email.strip().lower(): c for c in store.customers.values()}
    seen = set()
    reader = csv.reader(io.StringIO(text))
    next(reader)
    for row in reader:
        line = reader.line_num
        if not any(cell.strip() for cell in row):
            continue
        get = lambda k: row[col[k]].strip() if k in col and col[k] < len(row) else ""
        name, email, tz = get("name"), get("email").lower(), get("timezone") or "America/Los_Angeles"
        local, _, domain = email.partition("@")
        if not name:
            out["skipped"].append((line, "missing name")); continue
        if email.count("@") != 1 or not local or "." not in domain:
            out["skipped"].append((line, "invalid email")); continue
        if not _valid_tz(tz):
            out["skipped"].append((line, "invalid timezone")); continue
        if email in seen:
            out["skipped"].append((line, "duplicate in file")); continue
        seen.add(email)
        if email in by_email:
            c = by_email[email]
            c.name, c.timezone = name, tz
            out["updated"] += 1
        else:
            c = Customer(max(store.customers, default=0) + 1, name, email, tz)
            store.customers[c.id] = c
            by_email[email] = c
            out["added"] += 1
    return out
