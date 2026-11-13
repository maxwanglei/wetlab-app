from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.auth import CurrentUser, check_new_password, current_admin, hash_password, member_by_email
from app.db import get_session
from app.models import LabMember
from app.schemas import MemberIn, MemberOut, MemberUpdate, PasswordSet

router = APIRouter(prefix="/api/members", tags=["members"], dependencies=[Depends(current_admin)])
ADMIN_MEMBERSHIP_LOCK = 0x5745544C4142


def _out(member: LabMember) -> MemberOut:
    return MemberOut(
        id=member.id,
        full_name=member.full_name,
        email=member.email,
        role=member.role,
        is_admin=member.is_admin,
        is_active=member.is_active,
        can_sign_in=member.is_active and member.password_hash is not None,
    )


def _member(session: Session, member_id: int) -> LabMember:
    member = session.get(LabMember, member_id)
    if member is None:
        raise HTTPException(404, "No such lab member.")
    return member


@router.get("", response_model=list[MemberOut])
def list_members(session: Session = Depends(get_session)) -> list[MemberOut]:
    members = session.scalars(select(LabMember).order_by(LabMember.is_active.desc(), LabMember.full_name))
    return [_out(m) for m in members]


@router.post("", response_model=MemberOut, status_code=201)
def add_member(body: MemberIn, session: Session = Depends(get_session)) -> MemberOut:
    if member_by_email(session, body.email) is not None:
        raise HTTPException(409, f"{body.email} is already a lab member. Change that person instead.")
    check_new_password(body.password)
    member = LabMember(
        full_name=body.full_name,
        email=body.email,
        role=body.role,
        is_admin=body.is_admin,
        password_hash=hash_password(body.password),
    )
    session.add(member)
    session.commit()
    return _out(member)


@router.patch("/{member_id}", response_model=MemberOut)
def update_member(
    member_id: int, body: MemberUpdate, session: Session = Depends(get_session), admin: CurrentUser = Depends(current_admin)
) -> MemberOut:
    # Count and change admins in one serialized transaction, including concurrent self-demotions.
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADMIN_MEMBERSHIP_LOCK})
    session.expire_all()
    requester = session.get(LabMember, admin.member_id)
    if requester is None or not requester.is_active or not requester.is_admin:
        raise HTTPException(403, "Only an active admin can manage people.")
    member = _member(session, member_id)
    stays_admin = (body.is_admin if body.is_admin is not None else member.is_admin) and (
        body.is_active if body.is_active is not None else member.is_active
    )
    if member.is_admin and member.is_active and not stays_admin:
        others = session.scalar(
            select(func.count()).select_from(LabMember).where(
                LabMember.is_admin,
                LabMember.is_active,
                LabMember.password_hash.is_not(None),
                LabMember.email.is_not(None),
                LabMember.email != "",
                LabMember.id != member.id,
            )
        )
        if others == 0:
            raise HTTPException(409, "The lab needs at least one active admin who can sign in. Set another admin's password first.")
    if body.email is not None and body.email.lower() != (member.email or "").lower():
        if member_by_email(session, body.email) is not None:
            raise HTTPException(409, f"{body.email} is already another lab member's email.")
        member.email = body.email
    if body.full_name is not None:
        member.full_name = body.full_name
    if "role" in body.model_fields_set:
        member.role = body.role
    if body.is_admin is not None:
        member.is_admin = body.is_admin
    if body.is_active is not None and body.is_active != member.is_active:
        member.is_active = body.is_active
        member.session_version += 1
    session.commit()
    return _out(member)


@router.post("/{member_id}/password", response_model=MemberOut)
def set_password(member_id: int, body: PasswordSet, session: Session = Depends(get_session)) -> MemberOut:
    """A new password signs that person out everywhere."""
    member = _member(session, member_id)
    check_new_password(body.new_password)
    member.password_hash = hash_password(body.new_password)
    member.session_version += 1
    session.commit()
    return _out(member)
