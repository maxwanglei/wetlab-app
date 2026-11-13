from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.db import get_engine
from app.main import app
from app.routes import auth as auth_routes
from app.seed.demo import reset
from scripts.add_member import add_member

FETCH = {"X-Requested-With": "wetlab"}
ADMIN = ("admin@example.org", "admin password 1")
MEMBER = ("ada@example.org", "ada password 12")


@pytest.fixture
def client(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    auth_routes._failures.clear()
    monkeypatch.delenv("DEV_USER_EMAIL", raising=False)
    from sqlalchemy.orm import Session

    with Session(engine) as session:
        add_member(session, ADMIN[0], "Lab Admin", "PI", ADMIN[1], admin=True)
        add_member(session, MEMBER[0], "Ada Lovelace", "postdoc", MEMBER[1])
    with TestClient(app) as test_client:
        yield test_client


def sign_in(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password}, headers=FETCH)


def test_nothing_but_health_answers_without_a_session(client: TestClient) -> None:
    assert client.get("/api/health").status_code == 200
    for path in ("/api/me", "/api/experiments", "/api/dashboard", "/api/reference", "/api/inventory/reagent-lots", "/api/members"):
        assert client.get(path).status_code == 401, path


def test_a_member_signs_in_and_out(client: TestClient) -> None:
    me = sign_in(client, "ADA@example.org", MEMBER[1])
    assert me.status_code == 200 and me.json()["full_name"] == "Ada Lovelace" and me.json()["is_admin"] is False
    cookie = me.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/experiments").status_code == 200
    assert client.post("/api/auth/logout", json={}, headers=FETCH).status_code == 204
    assert client.get("/api/experiments").status_code == 401


def test_every_refusal_reads_the_same(client: TestClient) -> None:
    wrong = sign_in(client, MEMBER[0], "not the password")
    unknown = sign_in(client, "nobody@example.org", MEMBER[1])
    no_password = sign_in(client, "pi@example.org", "anything at all")
    assert wrong.status_code == unknown.status_code == no_password.status_code == 401
    assert wrong.json() == unknown.json() == no_password.json() == {"detail": "Email or password is wrong."}


def test_five_wrong_passwords_lock_that_email_for_a_while(client: TestClient) -> None:
    for _ in range(5):
        assert sign_in(client, MEMBER[0], "not the password").status_code == 401
    assert sign_in(client, MEMBER[0], MEMBER[1]).status_code == 429
    assert sign_in(client, ADMIN[0], ADMIN[1]).status_code == 200, "another email is not locked"


def test_a_forged_or_tampered_cookie_is_refused(client: TestClient) -> None:
    sign_in(client, MEMBER[0], MEMBER[1])
    member_id, version, expires, signature = client.cookies["wetlab_session"].split(".")
    admin_id = sign_in(TestClient(app), ADMIN[0], ADMIN[1]).json()["member_id"]
    client.cookies.set("wetlab_session", f"{admin_id}.{version}.{expires}.{signature}")
    assert client.get("/api/me").status_code == 401


def test_admins_manage_people_and_others_cannot(client: TestClient) -> None:
    sign_in(client, MEMBER[0], MEMBER[1])
    assert client.get("/api/members").status_code == 403
    sign_in(client, ADMIN[0], ADMIN[1])
    added = client.post(
        "/api/members",
        json={"full_name": "Grace Hopper", "email": "grace@example.org", "role": "technician", "password": "grace password"},
        headers=FETCH,
    )
    assert added.status_code == 201 and added.json()["can_sign_in"] is True
    again = client.post(
        "/api/members", json={"full_name": "Dup", "email": "GRACE@example.org", "password": "grace password"}, headers=FETCH
    )
    assert again.status_code == 409
    short = client.post("/api/members", json={"full_name": "Short", "email": "s@example.org", "password": "short"}, headers=FETCH)
    assert short.status_code == 422
    people = {m["email"]: m for m in client.get("/api/members").json()}
    assert people["pi@example.org"]["can_sign_in"] is False


def test_deactivating_or_resetting_ends_that_persons_sessions(client: TestClient) -> None:
    ada = TestClient(app)
    ada_id = sign_in(ada, MEMBER[0], MEMBER[1]).json()["member_id"]
    sign_in(client, ADMIN[0], ADMIN[1])

    client.post(f"/api/members/{ada_id}/password", json={"new_password": "a new password"}, headers=FETCH)
    assert ada.get("/api/me").status_code == 401
    assert sign_in(ada, MEMBER[0], "a new password").status_code == 200

    client.patch(f"/api/members/{ada_id}", json={"is_active": False}, headers=FETCH)
    assert ada.get("/api/me").status_code == 401
    assert sign_in(ada, MEMBER[0], "a new password").status_code == 401


def test_changing_your_own_password_keeps_you_in_and_ends_other_sessions(client: TestClient) -> None:
    other = TestClient(app)
    sign_in(other, MEMBER[0], MEMBER[1])
    sign_in(client, MEMBER[0], MEMBER[1])
    wrong = client.post("/api/auth/password", json={"current_password": "nope", "new_password": "another password"}, headers=FETCH)
    assert wrong.status_code == 422
    changed = client.post("/api/auth/password", json={"current_password": MEMBER[1], "new_password": "another password"}, headers=FETCH)
    assert changed.status_code == 200
    assert client.get("/api/me").status_code == 200
    assert other.get("/api/me").status_code == 401


def test_the_last_active_admin_stays_an_admin(client: TestClient) -> None:
    admin_id = sign_in(client, ADMIN[0], ADMIN[1]).json()["member_id"]
    assert client.patch(f"/api/members/{admin_id}", json={"is_admin": False}, headers=FETCH).status_code == 409
    assert client.patch(f"/api/members/{admin_id}", json={"is_active": False}, headers=FETCH).status_code == 409
    ada_id = next(m["id"] for m in client.get("/api/members").json() if m["email"] == MEMBER[0])
    assert client.patch(f"/api/members/{ada_id}", json={"is_admin": True}, headers=FETCH).status_code == 200
    assert client.patch(f"/api/members/{admin_id}", json={"is_admin": False}, headers=FETCH).status_code == 200


def test_saves_are_attributed_to_the_signed_in_member(client: TestClient) -> None:
    sign_in(client, MEMBER[0], MEMBER[1])
    created = client.post("/api/experiments", json={"title": "Signed in", "study_type": "substrate_depletion", "substrate": "midazolam"}, headers=FETCH)
    assert created.status_code == 201, created.text
    assert created.json()["performed_by"] == "Ada Lovelace"


def test_odd_cookies_and_proxied_requests_get_no_free_pass(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    odd = {"Cookie": "wetlab_session=1.0.9999999999.sïgnatüre".encode()}
    assert client.get("/api/me", headers=odd).status_code == 401
    monkeypatch.setenv("DEV_USER_EMAIL", "demo@example.org")
    assert client.get("/api/me").status_code == 200
    assert client.get("/api/me", headers={"X-Forwarded-For": "203.0.113.9"}).status_code == 401
    assert '"openapi"' not in client.get("/openapi.json").text and "swagger" not in client.get("/docs").text.lower()


def test_an_admin_can_correct_an_email(client: TestClient) -> None:
    sign_in(client, ADMIN[0], ADMIN[1])
    ada_id = next(m["id"] for m in client.get("/api/members").json() if m["email"] == MEMBER[0])
    taken = client.patch(f"/api/members/{ada_id}", json={"email": "ADMIN@example.org"}, headers=FETCH)
    assert taken.status_code == 409
    moved = client.patch(f"/api/members/{ada_id}", json={"email": "ada.lovelace@example.org"}, headers=FETCH)
    assert moved.status_code == 200 and moved.json()["email"] == "ada.lovelace@example.org"
    assert sign_in(TestClient(app), "ada.lovelace@example.org", MEMBER[1]).status_code == 200


def test_a_passwordless_admin_cannot_be_the_last_admin(client: TestClient) -> None:
    admin_id = sign_in(client, ADMIN[0], ADMIN[1]).json()["member_id"]
    pi = next(m for m in client.get("/api/members").json() if m["email"] == "pi@example.org")
    assert pi["can_sign_in"] is False
    assert client.patch(f"/api/members/{pi['id']}", json={"is_admin": True}, headers=FETCH).status_code == 200
    for change in ({"is_admin": False}, {"is_active": False}):
        rejected = client.patch(f"/api/members/{admin_id}", json=change, headers=FETCH)
        assert rejected.status_code == 409
        assert "who can sign in" in rejected.json()["detail"]
    client.post(f"/api/members/{pi['id']}/password", json={"new_password": "another admin password"}, headers=FETCH)
    assert client.patch(f"/api/members/{admin_id}", json={"is_admin": False}, headers=FETCH).status_code == 200


def test_concurrent_admin_demotions_keep_one_admin(client: TestClient) -> None:
    admin_id = sign_in(client, ADMIN[0], ADMIN[1]).json()["member_id"]
    other = TestClient(app)
    other_id = sign_in(other, MEMBER[0], MEMBER[1]).json()["member_id"]
    assert client.patch(f"/api/members/{other_id}", json={"is_admin": True}, headers=FETCH).status_code == 200
    start = Barrier(2)

    def demote(browser: TestClient, member_id: int) -> int:
        start.wait(timeout=10)
        return browser.patch(f"/api/members/{member_id}", json={"is_admin": False}, headers=FETCH).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(demote, client, admin_id)
        second = pool.submit(demote, other, other_id)
        assert sorted([first.result(timeout=20), second.result(timeout=20)]) == [200, 409]
    remaining = client if client.get("/api/me").json()["is_admin"] else other
    admins = [m for m in remaining.get("/api/members").json() if m["is_admin"] and m["can_sign_in"]]
    assert len(admins) == 1


def test_a_queued_former_admin_cannot_change_people(client: TestClient, engine: Engine) -> None:
    from fastapi import HTTPException
    from sqlalchemy.orm import Session

    from app.auth import CurrentUser
    from app.routes.members import update_member
    from app.schemas import MemberUpdate

    sign_in(client, ADMIN[0], ADMIN[1])
    other = next(m for m in client.get("/api/members").json() if m["email"] == MEMBER[0])
    assert client.patch(f"/api/members/{other['id']}", json={"is_admin": True}, headers=FETCH).status_code == 200
    queued_identity = CurrentUser(MEMBER[0], other["id"], other["full_name"], True)
    assert client.patch(f"/api/members/{other['id']}", json={"is_admin": False}, headers=FETCH).status_code == 200
    with Session(engine) as session:
        with pytest.raises(HTTPException) as rejected:
            update_member(other["id"], MemberUpdate(is_admin=True), session, queued_identity)
        assert rejected.value.status_code == 403
