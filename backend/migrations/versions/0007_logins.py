"""Personal logins: a password, an admin flag, and a session version on each lab member.

A member with no password cannot sign in, so every existing member, the sample's made-up ones included, starts
unable to. Raising session_version ends that member's sessions everywhere. Emails become unique without regard
to case, since sign-in matches them that way; the migration stops, naming them, if two members' emails differ
only by case. Nothing that exists changes."""

from alembic import op

revision = "0007_logins"
down_revision = "0006_components_and_solutions"

COLUMNS = """
ALTER TABLE lab.lab_member
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
"""

UNIQUE_EMAIL = """
DO $$
DECLARE clashes TEXT;
BEGIN
  SELECT string_agg(emails, '; ') INTO clashes FROM (
    SELECT string_agg(email, ', ' ORDER BY id) AS emails FROM lab.lab_member
    WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1
  ) AS clash;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'lab members share an email that differs only by case (%); merge or rename them first', clashes;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_member_email_lower ON lab.lab_member (lower(email));
"""


def upgrade() -> None:
    op.execute(COLUMNS)
    op.execute(UNIQUE_EMAIL)


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS lab.uq_lab_member_email_lower;
        ALTER TABLE lab.lab_member
            DROP COLUMN IF EXISTS session_version,
            DROP COLUMN IF EXISTS is_admin,
            DROP COLUMN IF EXISTS password_hash;
        """
    )
