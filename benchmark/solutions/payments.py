def deposit_cents(price_cents: int) -> int:
    if price_cents < 0:
        raise ValueError("price can't be negative")
    return min(2000, price_cents)
