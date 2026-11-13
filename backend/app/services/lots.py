import datetime as dt

EXPIRY_WARNING_DAYS = 30
LOW_STOCK_FRACTION = 0.25


def days_to_expiry(expiry: dt.date | None, today: dt.date) -> int | None:
    return (expiry - today).days if expiry else None


def percent_remaining(received: float | None, remaining: float | None) -> float | None:
    if received is None or remaining is None or received <= 0:
        return None
    return 100 * float(remaining) / float(received)


def lot_flags(
    expiry: dt.date | None,
    today: dt.date,
    received: float | None,
    remaining: float | None,
    is_depleted: bool,
) -> list[str]:
    flags = []
    days = days_to_expiry(expiry, today)
    if days is not None and days < 0:
        flags.append("expired")
    elif days is not None and days <= EXPIRY_WARNING_DAYS:
        flags.append("expiring_soon")
    if is_depleted or remaining == 0:
        flags.append("depleted")
    else:
        percent = percent_remaining(received, remaining)
        if percent is not None and percent < 100 * LOW_STOCK_FRACTION:
            flags.append("low_stock")
    return flags
