from datetime import timedelta

import pytest
from cart_types import Cart, CheckoutError
from cart_validation import validate_cart


def test_valid_cart_passes(store, now):
    assert validate_cart(store, Cart(1, 1, [1, 3]), now) is None
    assert validate_cart(store, Cart(1, 4, [1]), now) is None          # slot 4: only a cancelled booking


@pytest.mark.parametrize("cart", [
    Cart(99, 1, [1]),          # no such customer
    Cart(1, 1, []),            # no pets
    Cart(1, 1, [1, 1]),        # same pet twice
    Cart(1, 1, [2]),           # Mochi belongs to Lee
    Cart(1, 1, [42]),          # no such pet
    Cart(1, 99, [1]),          # no such slot
    Cart(1, 2, [1]),           # slot 2 is booked
])
def test_problems_raise_checkout_error(store, now, cart):
    with pytest.raises(CheckoutError):
        validate_cart(store, cart, now)


def test_slot_must_be_in_the_future(store):
    start = store.slots[1].starts_at
    with pytest.raises(CheckoutError):
        validate_cart(store, Cart(1, 1, [1]), start)
    validate_cart(store, Cart(1, 1, [1]), start - timedelta(seconds=1))
