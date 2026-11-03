import payments
import pricing
from cart_types import Cart, CheckoutError


def price_cart(cart: Cart, profiles: dict) -> tuple[int, int]:
    try:
        pets = [profiles[pid] for pid in cart.pet_ids]
    except KeyError:
        raise CheckoutError("We're missing details for one of your pets.") from None
    try:
        total = pricing.quote(cart.services, pets, cart.coupon)
    except ValueError as e:
        raise CheckoutError(f"We couldn't price that order: {e}") from None
    return total, payments.deposit_cents(total)
