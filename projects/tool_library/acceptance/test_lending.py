from datetime import date

import pytest
from lending import checkout_tool, return_tool
from models import Library, LibraryError, Member, Tool

D = date(2026, 11, 2)


@pytest.fixture
def lib():
    return Library({1: Member(1, "Ana"), 2: Member(2, "Bo")}, {i: Tool(i, f"tool{i}", 100) for i in range(1, 6)})


def test_checkout(lib):
    loan = checkout_tool(lib, 1, 1, D, 7)
    assert (loan.id, loan.due, loan.returned) == (1, date(2026, 11, 9), None) and lib.loans[1] is loan


def test_tool_already_out_and_limits(lib):
    checkout_tool(lib, 1, 1, D, 1)
    with pytest.raises(LibraryError):
        checkout_tool(lib, 2, 1, D, 1)
    checkout_tool(lib, 1, 2, D, 1)
    checkout_tool(lib, 1, 3, D, 1)
    with pytest.raises(LibraryError):
        checkout_tool(lib, 1, 4, D, 1)
    with pytest.raises(LibraryError):
        checkout_tool(lib, 2, 5, D, 0)


def test_return(lib):
    loan = checkout_tool(lib, 1, 1, D, 1)
    assert return_tool(lib, loan.id, D).returned == D
    with pytest.raises(LibraryError):
        return_tool(lib, loan.id, D)
    assert checkout_tool(lib, 2, 1, D, 1).id == 2
