import re


def normalize_email(raw: str) -> str:
    e = raw.strip().lower()
    if e.count("@") != 1:
        raise ValueError("invalid email")
    name, domain = e.split("@")
    if not name or "." not in domain or domain.startswith(".") or domain.endswith(".") or " " in e:
        raise ValueError("invalid email")
    return e


def normalize_phone(raw: str) -> str:
    s = raw.strip()
    if re.search(r"[A-Za-z]", s):
        raise ValueError("invalid phone")
    if s.startswith("+"):
        s = s[1:]
    digits = re.sub(r"[\s\-.()]", "", s)
    if not digits.isdigit():
        raise ValueError("invalid phone")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        raise ValueError("invalid phone")
    return "+1" + digits
