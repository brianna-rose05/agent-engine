from cart_types import Cart, CheckoutError


def validate_cart(store, cart: Cart, now) -> None:
    if cart.customer_id not in store.customers:
        raise CheckoutError("We couldn't find your account.")
    if not cart.pet_ids:
        raise CheckoutError("Add at least one pet.")
    if len(set(cart.pet_ids)) != len(cart.pet_ids):
        raise CheckoutError("Each pet can only be added once.")
    for pid in cart.pet_ids:
        pet = store.pets.get(pid)
        if pet is None or pet.customer_id != cart.customer_id:
            raise CheckoutError("One of those pets isn't on your account.")
    slot = store.slots.get(cart.slot_id)
    if slot is None or slot.starts_at <= now:
        raise CheckoutError("That time isn't available.")
    if any(b.slot_id == cart.slot_id and b.status == "booked" for b in store.bookings.values()):
        raise CheckoutError("That time was just taken.")
