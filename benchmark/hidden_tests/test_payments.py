import pytest
from payments import deposit_cents

@pytest.mark.parametrize("price,dep", [(6000, 2000), (2000, 2000), (1500, 1500), (0, 0), (1, 1)])
def test_deposit(price, dep):
    assert deposit_cents(price) == dep

def test_negative():
    with pytest.raises(ValueError):
        deposit_cents(-1)
