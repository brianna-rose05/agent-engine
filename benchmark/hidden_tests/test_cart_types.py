import dataclasses

from cart_types import Cart, CheckoutError, Receipt
from store import BookingError


def fields(cls):
    return [(f.name, f.default if f.default is not dataclasses.MISSING else
             ("factory" if f.default_factory is not dataclasses.MISSING else None)) for f in dataclasses.fields(cls)]


def test_cart_shape():
    assert dataclasses.is_dataclass(Cart)
    assert fields(Cart) == [("customer_id", None), ("slot_id", None), ("pet_ids", None),
                            ("services", "factory"), ("coupon", None)]
    a, b = Cart(1, 2, [3]), Cart(1, 2, [3])
    assert a.services == [] and a.coupon is None
    a.services.append("nails")
    assert b.services == []                          # no shared default list
    assert Cart(1, 2, [3], ["teeth"], "FLAT15").coupon == "FLAT15"


def test_receipt_shape():
    assert dataclasses.is_dataclass(Receipt)
    assert [f.name for f in dataclasses.fields(Receipt)] == ["booking_ids", "total_cents", "deposit_cents"]
    assert Receipt([1], 2, 3) == Receipt([1], 2, 3)


def test_checkout_error_is_a_booking_error():
    assert issubclass(CheckoutError, BookingError)
