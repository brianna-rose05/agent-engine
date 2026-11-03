from importer import import_customers


def lines(res):
    return [n for n, _ in res["skipped"]]


def test_adds_and_updates(store):
    csv_text = "Email,NAME,Phone,TimeZone\nnew@example.com,Ava,555,America/New_York\n DANA@Example.com ,Dana R.,,\n"
    res = import_customers(store, csv_text)
    assert (res["added"], res["updated"], res["skipped"]) == (1, 1, [])
    ava = store.customers[3]
    assert (ava.name, ava.email, ava.timezone) == ("Ava", "new@example.com", "America/New_York")
    assert store.customers[1].name == "Dana R." and store.customers[1].timezone == "America/Los_Angeles"
    assert len(store.customers) == 3


def test_bom_quotes_and_missing_timezone_column(store):
    res = import_customers(store, '﻿name,email\n"Smith, Jo",jo@example.com\n')
    assert res["added"] == 1
    jo = store.customers[3]
    assert jo.name == "Smith, Jo" and jo.timezone == "America/Los_Angeles"


def test_skips_with_line_numbers(store):
    csv_text = ("name,email,timezone\n"
                "Ok One,one@example.com,\n"          # 2 ok
                ",noname@example.com,\n"             # 3 missing name
                "Bad,not-an-email,\n"                # 4 bad email
                "Bad2,a@b@example.com,\n"            # 5 two @
                "Bad3,nodot@example,\n"              # 6 no dot in domain
                "Zone,zone@example.com,Mars/Base\n"  # 7 bad tz
                "Dup,ONE@example.com,\n"             # 8 duplicate in file
                "\n"                                 # 9 blank, ignored
                "Ok Two,two@example.com,Europe/London\n")  # 10 ok
    res = import_customers(store, csv_text)
    assert res["added"] == 2 and res["updated"] == 0
    assert lines(res) == [3, 4, 5, 6, 7, 8]
    assert all(isinstance(r, str) and r for _, r in res["skipped"])
    assert sorted(c.email for c in store.customers.values())[-2:] == ["one@example.com", "two@example.com"]


def test_ids_continue_from_max(store):
    from store import Customer
    store.customers[10] = Customer(10, "Old", "old@example.com")
    import_customers(store, "name,email\nNew,new@example.com\n")
    assert 11 in store.customers


def test_existing_customer_email_case_insensitive(store):
    store.customers[2].email = "Lee@Example.com"
    res = import_customers(store, "name,email,timezone\nLee Park,lee@example.com,Asia/Tokyo\n")
    assert res["updated"] == 1 and res["added"] == 0
    assert store.customers[2].name == "Lee Park" and store.customers[2].timezone == "Asia/Tokyo"
