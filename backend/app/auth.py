"""Who is signed in. A signed session cookie names a lab member; without one, DEV_USER_EMAIL names the member
for the one-computer install, local development and the tests. Otherwise the request is refused with 401."""

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import LabMember

COOKIE = "wetlab_session"
SESSION_SECONDS = 14 * 24 * 3600
MIN_PASSWORD_LENGTH = 10
# Without a configured secret, sessions last until the app restarts.
_SECRET = (os.environ.get("SESSION_SECRET") or secrets.token_urlsafe(32)).encode()
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}
# Each hash takes 16 MiB, so only two run at once, whatever a flood of sign-in attempts asks for.
_HASHING = threading.BoundedSemaphore(2)


@dataclass(frozen=True)
class CurrentUser:
    email: str
    member_id: int
    full_name: str
    is_admin: bool


def _scrypt(password: str, salt: bytes) -> bytes:
    with _HASHING:
        return hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${_scrypt(password, salt).hex()}"


def password_matches(password: str, stored: str | None) -> bool:
    """Always does the full hashing work, so an unknown member takes as long as a wrong password."""
    scheme, salt, digest = (stored or "scrypt$00$00").split("$")
    computed = _scrypt(password, bytes.fromhex(salt))
    return stored is not None and scheme == "scrypt" and hmac.compare_digest(computed.hex().encode(), digest.encode())


def check_new_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"A password needs at least {MIN_PASSWORD_LENGTH} characters.")


def _sign(payload: str) -> str:
    return base64.urlsafe_b64encode(hmac.new(_SECRET, payload.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def start_session(response: Response, request: Request, member: LabMember) -> None:
    payload = f"{member.id}.{member.session_version}.{int(time.time()) + SESSION_SECONDS}"
    response.set_cookie(
        COOKIE,
        f"{payload}.{_sign(payload)}",
        max_age=SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )


def end_session(response: Response) -> None:
    response.delete_cookie(COOKIE)


def _session_member(request: Request, session: Session) -> LabMember | None:
    raw = request.cookies.get(COOKIE, "")
    payload, _, signature = raw.rpartition(".")
    if not payload or not hmac.compare_digest(signature.encode(), _sign(payload).encode()):
        return None
    try:
        member_id, version, expires = (int(part) for part in payload.split("."))
    except ValueError:
        return None
    if expires < time.time():
        return None
    member = session.get(LabMember, member_id)
    if member is None or not member.is_active or member.password_hash is None or member.session_version != version:
        return None
    return member


def member_by_email(session: Session, email: str) -> LabMember | None:
    return session.scalar(select(LabMember).where(func.lower(LabMember.email) == email.strip().lower()))


def current_user(request: Request, session: Session = Depends(get_session)) -> CurrentUser:
    member = _session_member(request, session)
    # A request a proxy forwarded comes from a server, never the one-computer install, so it must sign in.
    proxied = "x-forwarded-for" in request.headers
    if member is None and not proxied and (dev_email := os.environ.get("DEV_USER_EMAIL")):
        member = member_by_email(session, dev_email)
        if member is None or not member.is_active:
            raise HTTPException(403, f"DEV_USER_EMAIL names no active lab member: {dev_email}")
    if member is None:
        raise HTTPException(401, "Sign in to continue.")
    return CurrentUser(email=member.email or "", member_id=member.id, full_name=member.full_name, is_admin=member.is_admin)


def current_admin(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Only an admin can manage people.")
    return user
