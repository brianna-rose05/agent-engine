SIZES = {"small": 4000, "medium": 5500, "large": 7000}
COATS = {"short": 0, "long": 1000}
SERVICES = {"nails": 800, "teeth": 1250, "deshed": 1500}


def _half_up_pct(amount, pct):
    return (amount * pct + 50) // 100


def quote(services, pets, coupon):
    if not pets:
        raise ValueError("no pets")
    svc = set(services)
    if svc - SERVICES.keys():
        raise ValueError("unknown service")
    totals = []
    for p in pets:
        if p.get("size") not in SIZES or p.get("coat") not in COATS:
            raise ValueError("bad pet")
        t = SIZES[p["size"]] + COATS[p["coat"]]
        for s in svc:
            if s == "deshed" and p["coat"] != "long":
                continue
            t += SERVICES[s]
        totals.append(t)
    total = sum(totals)
    if len(totals) >= 2:
        total -= _half_up_pct(min(totals), 15)
    code = (coupon or "").strip().upper()
    if code == "WELCOME10":
        total -= _half_up_pct(total, 10)
    elif code == "FLAT15":
        total = max(0, total - 1500)
    elif code:
        raise ValueError("unknown coupon")
    return total
