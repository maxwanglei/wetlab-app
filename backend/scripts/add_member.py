"""Add a lab member, or update the one already listed under the same email. The app attributes each save to the
member whose email the signed-in account carries, so a new lab database needs at least one member.
    Usage: cd backend && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5433/wetlab \\
               uv run python -m scripts.add_member --email ada@example.org --name "Ada Lovelace" --role postdoc
--password asks for a password to sign in with; --password-stdin reads it from the first line of input.
--admin lets the member manage people.
"""

import argparse
import getpass
import sys

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.auth import MIN_PASSWORD_LENGTH, hash_password
from app.db import get_engine
from app.models import LabMember


def add_member(
    session: Session, email: str, name: str | None, role: str | None, password: str | None = None, admin: bool = False
) -> tuple[LabMember, bool]:
    """The member with this email, matched without regard to case as sign-in matches it, created or brought up to
    date and made active, and whether it is new. A new member needs a name; an existing one keeps its name unless
    a new one is given."""
    email = email.strip()
    name = (name or "").strip()
    member = session.scalar(select(LabMember).where(func.lower(LabMember.email) == email.lower()).order_by(LabMember.id))
    created = member is None
    if member is None:
        if not name:
            raise ValueError("a new member needs --name")
        member = LabMember(full_name=name, email=email)
        session.add(member)
    elif name:
        member.full_name = name
    member.role = role or member.role
    member.is_active = True
    if admin:
        member.is_admin = True
    if password is not None:
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"a password needs at least {MIN_PASSWORD_LENGTH} characters")
        member.password_hash = hash_password(password)
        member.session_version = (member.session_version or 0) + 1
    session.commit()
    return member, created


def main() -> None:
    parser = argparse.ArgumentParser(description="Add or update a lab member.")
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", help="needed for a new member; for an existing one it replaces the name")
    parser.add_argument("--role", help="for example PI, postdoc or technician")
    parser.add_argument("--admin", action="store_true", help="let this member add people and reset passwords")
    asked = parser.add_mutually_exclusive_group()
    asked.add_argument("--password", action="store_true", help="ask for a password to sign in with")
    asked.add_argument("--password-stdin", action="store_true", help="read the password from the first line of input")
    args = parser.parse_args()
    password = None
    if args.password:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Again: ") != password:
            raise SystemExit("the two passwords differ")
    elif args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    with Session(get_engine()) as session:
        database = session.execute(text("SELECT current_database()")).scalar_one()
        try:
            member, created = add_member(session, args.email, args.name, args.role, password, args.admin)
        except ValueError as error:
            raise SystemExit(f"{error} (database {database})") from error
        extras = [label for label, on in (("admin", member.is_admin), ("can sign in", member.password_hash is not None)) if on]
        print(
            f"{'added' if created else 'updated'} lab member {member.id} in {database}: {member.full_name} <{member.email}>"
            + (f" ({', '.join(extras)})" if extras else "")
        )


if __name__ == "__main__":
    main()
