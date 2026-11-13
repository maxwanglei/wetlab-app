from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Engine

from app.models import Base

# Differences the models carry on purpose. The two views are mapped as tables so the app can read
# them. The unique indexes are expressions in the SQL, which sqlacodegen mirrors as plain columns.
KNOWN = {
    ("add_table", "v_lcms_batch_qc"),
    ("add_table", "v_lcms_study_result"),
    ("add_index", "uq_lab_expmod_arm"),
    ("remove_index", "uq_lab_expmod_arm"),
    ("add_index", "uq_lab_lcms_peak_channel"),
    ("remove_index", "uq_lab_lcms_peak_channel"),
    ("add_index", "uq_lab_expcontrol_label"),
    ("remove_index", "uq_lab_expcontrol_label"),
    ("add_index", "uq_lab_member_email_lower"),
    ("remove_index", "uq_lab_member_email_lower"),
}


def _key(diff: tuple) -> tuple[str, str]:
    kind, item = diff[0], diff[1]
    return kind, getattr(item, "name", str(item))


def test_the_models_mirror_the_migrated_schema(engine: Engine) -> None:
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={
                "include_schemas": True,
                "include_name": lambda name, type_, _parent: type_ != "schema" or name == "lab",
                "compare_type": True,
            },
        )
        diffs = compare_metadata(context, Base.metadata)
    flat = [d for diff in diffs for d in (diff if isinstance(diff, list) else [diff])]
    unexpected = [str(d)[:200] for d in flat if _key(d) not in KNOWN]
    assert unexpected == [], "backend/app/models.py no longer mirrors the migrations:\n" + "\n".join(unexpected)
