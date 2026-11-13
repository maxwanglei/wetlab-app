import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import LabMember
from scripts.add_member import add_member


def test_a_member_is_added_once_and_updated_by_email(session: Session) -> None:
    member, created = add_member(session, "ada@example.org", " Ada Lovelace ", "postdoc")
    assert created and (member.full_name, member.role, member.is_active) == ("Ada Lovelace", "postdoc", True)
    member.is_active = False
    session.commit()

    again, created_again = add_member(session, "ADA@example.org", None, None)
    assert not created_again and again.id == member.id
    assert (again.full_name, again.role, again.is_active) == ("Ada Lovelace", "postdoc", True), "no name keeps the name"

    renamed, _ = add_member(session, "ada@example.org", "Ada King", "PI")
    assert (renamed.id, renamed.full_name, renamed.role) == (member.id, "Ada King", "PI")
    assert session.scalar(select(func.count()).select_from(LabMember).where(func.lower(LabMember.email) == "ada@example.org")) == 1


def test_a_new_member_needs_a_name(session: Session) -> None:
    with pytest.raises(ValueError, match="needs --name"):
        add_member(session, "grace@example.org", " ", None)
