"""In-memory data model for the Paws and Suds booking app (the locked 'contract')."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Customer:
    id: int
    name: str
    email: str
    timezone: str = "America/Los_Angeles"


@dataclass
class Pet:
    id: int
    customer_id: int
    name: str
    breed: str


@dataclass
class Slot:
    id: int
    starts_at: datetime          # timezone-aware, stored in UTC
    price_cents: int = 6000


@dataclass
class Booking:
    id: int
    customer_id: int
    pet_id: int
    slot_id: int
    status: str = "booked"       # booked | cancelled


@dataclass
class Store:
    customers: dict[int, Customer] = field(default_factory=dict)
    pets: dict[int, Pet] = field(default_factory=dict)
    slots: dict[int, Slot] = field(default_factory=dict)
    bookings: dict[int, Booking] = field(default_factory=dict)

    def next_booking_id(self) -> int:
        return max(self.bookings, default=0) + 1


class BookingError(Exception):
    """Raised when a booking action is not allowed. Message is shown to the customer."""
