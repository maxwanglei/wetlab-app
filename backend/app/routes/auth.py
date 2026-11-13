import threading
import time
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser,
    check_new_password,
    current_user,
    end_session,
    hash_password,
    member_by_email,
    password_matches,
    start_session,
)
from app.db import get_session
from app.models import LabMember
from app.schemas import LoginIn, Me, PasswordChange

router = APIRouter(prefix="/api/auth", tags=["auth"])

MAX_FAILURES = 5
WINDOW_SECONDS = 15 * 60
MAX_TRACKED_EMAILS = 10_000
# Failed sign-ins per email, kept in memory: the app runs as one process.
_failures: OrderedDict[str, list[float]] = OrderedDict()
_lock = threading.Lock()


def _recent_failures(email: str, now: float) -> list[float]:
    recent = [at for at in _failures.get(email, []) if now - at < WINDOW_SECONDS]
    if recent:
        _failures[email] = recent
    else:
        _failures.pop(email, None)
    return recent


def _expire_failures(now: float) -> None:
    while _failures:
        _, failures = next(iter(_failures.items()))
        if now - failures[-1] < WINDOW_SECONDS:
            break
        _failures.popitem(last=False)


def _record_failure(email: str, now: float) -> None:
    _expire_failures(now)
    recent = _recent_failures(email, now)
    if email not in _failures and len(_failures) >= MAX_TRACKED_EMAILS:
        _failures.popitem(last=False)
    _failures[email] = [*recent, now][-MAX_FAILURES:]
    _failures.move_to_end(email)


def _me(member: LabMember) -> Me:
    return Me(email=member.email or "", full_name=member.full_name, member_id=member.id, is_admin=member.is_admin)


@router.post("/login", response_model=Me)
def login(body: LoginIn, request: Request, response: Response, session: Session = Depends(get_session)) -> Me:
    email = body.email.lower()
    now = time.time()
    with _lock:
        _expire_failures(now)
        if len(_recent_failures(email, now)) >= MAX_FAILURES:
            raise HTTPException(429, "Too many wrong passwords for this email. Try again in 15 minutes.")
    member = member_by_email(session, body.email)
    usable = member is not None and member.is_active
    if not (password_matches(body.password, member.password_hash if usable else None) and usable):
        with _lock:
            _record_failure(email, time.time())
        raise HTTPException(401, "Email or password is wrong.")
    with _lock:
        _failures.pop(email, None)
    start_session(response, request, member)
    return _me(member)


@router.post("/logout", status_code=204)
def logout(response: Response) -> None:
    end_session(response)


@router.post("/password", response_model=Me)
def change_password(
    body: PasswordChange,
    request: Request,
    response: Response,
    user: CurrentUser = Depends(current_user),
    session: Session = Depends(get_session),
) -> Me:
    """Changing your password signs you out everywhere else and keeps this browser signed in."""
    member = session.get(LabMember, user.member_id)
    if not password_matches(body.current_password, member.password_hash):
        raise HTTPException(422, "The current password is wrong.")
    check_new_password(body.new_password)
    member.password_hash = hash_password(body.new_password)
    member.session_version += 1
    session.commit()
    start_session(response, request, member)
    return _me(member)
