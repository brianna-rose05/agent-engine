import copy

import cart_pricing
import cart_validation
import pytest
from cart_types import Cart, CheckoutError, Receipt
from checkout import checkout

PROFILES = {1: {"size": "large", "coat": "short"}, 3: {"size": "small", "coat": "short"}}


def test_books_every_pet_and_returns_receipt(store, now):
    r = checkout(store, Cart(1, 5, [3, 1], ["teeth"]), PROFILES, now)
    assert isinstance(r, Receipt)
    assert r.booking_ids == [3, 4]
    assert (r.total_cents, r.deposit_cents) == (5250 + 8250 - 788, 2000)
    assert [(store.bookings[i].pet_id, store.bookings[i].slot_id, store.bookings[i].customer_id,
             store.bookings[i].status) for i in r.booking_ids] == [(3, 5, 1, "booked"), (1, 5, 1, "booked")]


@pytest.mark.parametrize("cart", [Cart(1, 2, [1]), Cart(1, 5, [2]), Cart(1, 5, [1], [], "BOGUS"), Cart(1, 5, [1, 3, 7])])
def test_failures_leave_store_untouched(store, now, cart):
    before = copy.deepcopy(store)
    with pytest.raises(CheckoutError):
        checkout(store, cart, {**PROFILES, 7: PROFILES[1]} if 7 in cart.pet_ids else PROFILES, now)
    assert store == before


def test_uses_shared_validation_and_pricing(store, now, monkeypatch):
    seen = []

    def fake_validate(s, c, n):
        seen.append("validate")

    def fake_price(c, p):
        seen.append("price")
        return 777, 77

    for mod, name, fn in ((cart_validation, "validate_cart", fake_validate), (cart_pricing, "price_cart", fake_price)):
        monkeypatch.setattr(mod, name, fn)
    import checkout as co
    for name, fn in (("validate_cart", fake_validate), ("price_cart", fake_price)):
        if hasattr(co, name):
            monkeypatch.setattr(co, name, fn)
    r = checkout(store, Cart(1, 5, [1]), PROFILES, now)
    assert seen == ["validate", "price"] and (r.total_cents, r.deposit_cents) == (777, 77)
