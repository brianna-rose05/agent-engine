from dataclasses import dataclass, field

from store import BookingError


@dataclass
class Cart:
    customer_id: int
    slot_id: int
    pet_ids: list[int]
    services: list[str] = field(default_factory=list)
    coupon: str | None = None


@dataclass
class Receipt:
    booking_ids: list[int]
    total_cents: int
    deposit_cents: int


class CheckoutError(BookingError):
    pass
