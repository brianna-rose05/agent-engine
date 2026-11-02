from datetime import date
from zoneinfo import ZoneInfo

from store import Store


def daily_schedule(store: Store, day: date, tz: str) -> list[str]:
    zone = ZoneInfo(tz)
    rows = []
    for b in store.bookings.values():
        if b.status != "booked":
            continue
        local = store.slots[b.slot_id].starts_at.astimezone(zone)
        if local.date() != day:
            continue
        pet, cust = store.pets[b.pet_id], store.customers[b.customer_id]
        hour = local.strftime("%I").lstrip("0")
        rows.append((local, f"{hour}:{local:%M} {local:%p}  {pet.name} ({pet.breed}) - {cust.name}"))
    return [line for _, line in sorted(rows)]
