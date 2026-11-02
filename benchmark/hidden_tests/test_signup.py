import pytest
from signup import normalize_email, normalize_phone

def test_email_ok():
    assert normalize_email("  Dana@Example.COM ") == "dana@example.com"

@pytest.mark.parametrize("bad", ["dana", "@example.com", "dana@@example.com", "dana@example", "dana@.com", "dana@example.", "da na@example.com"])
def test_email_bad(bad):
    with pytest.raises(ValueError):
        normalize_email(bad)

@pytest.mark.parametrize("raw", ["(415) 555-0132", "415.555.0132", "415 555 0132", "+1 415-555-0132", "1-415-555-0132", "4155550132"])
def test_phone_ok(raw):
    assert normalize_phone(raw) == "+14155550132"

@pytest.mark.parametrize("bad", ["555-0132", "2-415-555-0132", "415-555-013a", "+44 20 7946 0958", "", "415555013212"])
def test_phone_bad(bad):
    with pytest.raises(ValueError):
        normalize_phone(bad)
