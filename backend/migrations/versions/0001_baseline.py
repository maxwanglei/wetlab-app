"""Baseline: the lab schema exactly as deployed from db/wetlab_schema.sql."""

from pathlib import Path

from alembic import op

revision = "0001_baseline"
down_revision = None

SCHEMA_SQL = Path(__file__).resolve().parents[3] / "db" / "wetlab_schema.sql"


def upgrade() -> None:
    # The file wraps itself in BEGIN/COMMIT; Alembic owns the transaction here.
    # Raw DBAPI execute because the file's comments contain ':' and '%', which
    # SQLAlchemy text() and psycopg placeholders would both try to interpret.
    lines = SCHEMA_SQL.read_text().splitlines()
    sql = "\n".join(line for line in lines if line.strip() not in ("BEGIN;", "COMMIT;"))
    with op.get_bind().connection.dbapi_connection.cursor() as cursor:
        cursor.execute(sql)


def downgrade() -> None:
    name = op.get_bind().exec_driver_sql("SELECT current_database()").scalar_one()
    if not name.endswith(("_demo", "_test")):
        raise RuntimeError(f"refusing to drop schema lab in {name!r}: only demo or test databases roll back this far")
    op.execute("DROP SCHEMA lab CASCADE")
