import cart_pricing
import cart_validation
from cart_types import Receipt
from store import Booking


def checkout(store, cart, profiles, now) -> Receipt:
    cart_validation.validate_cart(store, cart, now)
    total, deposit = cart_pricing.price_cart(cart, profiles)
    ids = []
    for pid in cart.pet_ids:
        b = Booking(store.next_booking_id(), cart.customer_id, pid, cart.slot_id)
        store.bookings[b.id] = b
        ids.append(b.id)
    return Receipt(ids, total, deposit)
