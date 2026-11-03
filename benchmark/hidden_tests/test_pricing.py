import pytest
from pricing import quote

S = {"size": "small", "coat": "short"}
S_LONG = {"size": "small", "coat": "long"}
M = {"size": "medium", "coat": "short"}
M_LONG = {"size": "medium", "coat": "long"}
L = {"size": "large", "coat": "short"}


def test_single_pet_base():
    assert quote([], [S], None) == 4000
    assert quote([], [M_LONG], "") == 6500
    assert quote(["nails", "teeth"], [L], None) == 7000 + 800 + 1250


def test_deshed_only_on_long_coats_and_duplicates_once():
    assert quote(["deshed", "deshed", "nails"], [S], None) == 4800
    assert quote(["deshed"], [M_LONG], None) == 8000


def test_multi_pet_discount_on_cheapest():
    assert quote(["teeth"], [S, L], None) == 5250 + 8250 - 788      # 787.5 -> 788


def test_multi_pet_discount_rounds_half_up_not_to_even():
    assert quote(["teeth"], [M, L], None) == 6750 + 8250 - 1013     # 1012.5 -> 1013, not 1012


def test_welcome10_applies_after_multi_pet():
    assert quote(["teeth"], [S, L], " welcome10 ") == 12712 - 1271  # 1271.2 -> 1271
    assert quote([], [S], "WELCOME10") == 3600


def test_welcome10_rounds_half_up_not_to_even():
    # 6500 + 6500 - 975 = 12025; 10% = 1202.5 -> 1203
    assert quote(["deshed"], [S_LONG, S_LONG], "Welcome10") == 12025 - 1203


def test_flat15_never_negative():
    assert quote([], [S], "flat15") == 2500
    assert quote([], [S, S, S], "FLAT15") == 12000 - 600 - 1500


@pytest.mark.parametrize("services,pets,coupon", [
    (["bath"], [S], None), ([], [], None), ([], [{"size": "huge", "coat": "short"}], None),
    ([], [{"size": "small", "coat": "curly"}], None), ([], [S], "FREE"),
])
def test_invalid(services, pets, coupon):
    with pytest.raises(ValueError):
        quote(services, pets, coupon)
