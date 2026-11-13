import pytest

from app.routes import auth


@pytest.fixture(autouse=True)
def clear_failures():
    auth._failures.clear()
    yield
    auth._failures.clear()


def test_expired_failed_emails_leave_no_tracking_entries() -> None:
    auth._record_failure("one@example.org", 0)
    auth._record_failure("two@example.org", 1)
    auth._record_failure("one@example.org", 2)
    auth._expire_failures(auth.WINDOW_SECONDS + 1)
    assert set(auth._failures) == {"one@example.org"}
    auth._expire_failures(auth.WINDOW_SECONDS + 2)
    assert not auth._failures
    assert auth._recent_failures("unknown@example.org", 2000) == []
    assert not auth._failures


def test_failed_email_tracking_and_each_emails_history_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MAX_TRACKED_EMAILS", 3)
    for index in range(6):
        auth._record_failure(f"unknown-{index}@example.org", index)
    assert len(auth._failures) == 3
    assert "unknown-0@example.org" not in auth._failures
    for now in range(6, 20):
        auth._record_failure("unknown-5@example.org", now)
    assert len(auth._failures["unknown-5@example.org"]) == auth.MAX_FAILURES
