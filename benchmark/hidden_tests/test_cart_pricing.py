import cart_pricing
import payments
import pricing
import pytest
from cart_types import Cart, CheckoutError
from cart_pricing import price_cart

PROFILES = {1: {"size": "large", "coat": "short"}, 3: {"size": "small", "coat": "short"}}


def test_total_and_deposit():
    assert price_cart(Cart(1, 1, [3]), PROFILES) == (4000, 2000)
    total = 5250 + 8250 - 788
    assert price_cart(Cart(1, 1, [1, 3], ["teeth"]), PROFILES) == (total, 2000)
    assert price_cart(Cart(1, 1, [3], [], "flat15"), PROFILES) == (2500, 2000)
    assert price_cart(Cart(1, 1, [3], [], "flat15"), {3: {"size": "small", "coat": "short"}})[1] == 2000


def test_reuses_existing_pricing_and_deposit(monkeypatch):
    calls = []

    def fake_quote(services, pets, coupon):
        calls.append(("quote", services, pets, coupon))
        return 1234

    def fake_deposit(total):
        calls.append(("deposit", total))
        return 99

    for mod in (pricing, cart_pricing):
        if hasattr(mod, "quote"):
            monkeypatch.setattr(mod, "quote", fake_quote)
    for mod in (payments, cart_pricing):
        if hasattr(mod, "deposit_cents"):
            monkeypatch.setattr(mod, "deposit_cents", fake_deposit)
    assert price_cart(Cart(1, 1, [1, 3], ["nails"], "X"), PROFILES) == (1234, 99)
    assert calls == [("quote", ["nails"], [PROFILES[1], PROFILES[3]], "X"), ("deposit", 1234)]


@pytest.mark.parametrize("cart", [Cart(1, 1, [7]), Cart(1, 1, [3], [], "BOGUS"), Cart(1, 1, [3], ["bath"])])
def test_errors_become_checkout_errors(cart):
    with pytest.raises(CheckoutError):
        price_cart(cart, PROFILES)
