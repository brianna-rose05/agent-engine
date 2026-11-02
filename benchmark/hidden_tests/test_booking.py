import pytest
from booking import book
from store import BookingError

def test_books_and_stores(store, now):
    b = book(store, 1, 1, 3, now)
    assert b.status == "booked" and b.slot_id == 3 and store.bookings[b.id] is b and b.id == 3

def test_rejects_taken_slot(store, now):
    with pytest.raises(BookingError):
        book(store, 1, 1, 2, now)

def test_cancelled_slot_is_bookable(store, now):
    assert book(store, 1, 3, 4, now).slot_id == 4

def test_rejects_someone_elses_pet(store, now):
    with pytest.raises(BookingError):
        book(store, 1, 2, 3, now)

def test_rejects_unknown_slot_and_pet(store, now):
    with pytest.raises(BookingError):
        book(store, 1, 1, 99, now)
    with pytest.raises(BookingError):
        book(store, 1, 99, 3, now)

def test_rejects_past_and_exact_now(store):
    with pytest.raises(BookingError):
        book(store, 1, 1, 3, store.slots[3].starts_at)

def test_double_book_same_call_twice(store, now):
    book(store, 1, 1, 5, now)
    with pytest.raises(BookingError):
        book(store, 1, 3, 5, now)
