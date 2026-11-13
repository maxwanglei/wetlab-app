"""Inhibitors that block more than one enzyme, and experiments read once at a single endpoint.

An arm keeps its target enzyme and can name further targets, in order, so ketoconazole can name CYP3A4 and then
CYP3A5. An experiment says how it is sampled: a time course, as every existing one is, or a single endpoint read
once at the end of its last stage. Each arm and control can run for its own time in its stage, NULL meaning the
stage's time, and plans its own number of replicate wells; the default of 3 keeps inserts from an older build
working. Nothing that exists changes."""

from alembic import op

revision = "0008_endpoint_inhibition"
down_revision = "0007_logins"

CREATE_EXTRA_TARGETS = """
CREATE TABLE IF NOT EXISTS lab.experiment_modulator_extra_target (
    experiment_modulator_id BIGINT NOT NULL REFERENCES lab.experiment_modulator(id) ON DELETE CASCADE,
    enzyme_id               BIGINT NOT NULL REFERENCES lab.enzyme(id) ON DELETE RESTRICT,
    position                INTEGER NOT NULL CONSTRAINT ck_expmod_extra_target_position CHECK (position >= 1),
    PRIMARY KEY (experiment_modulator_id, enzyme_id)
);
"""


def add_constraint(table: str, name: str, definition: str) -> str:
    return f"""
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{name}') THEN
    ALTER TABLE {table} ADD CONSTRAINT {name} {definition};
  END IF;
END $$;
"""


def time_and_replicates(table: str, short: str) -> str:
    return (
        f"""
ALTER TABLE {table}
    ADD COLUMN IF NOT EXISTS incubation_minutes NUMERIC,
    ADD COLUMN IF NOT EXISTS replicates         INTEGER NOT NULL DEFAULT 3;
"""
        + add_constraint(table, f"ck_{short}_minutes", "CHECK (incubation_minutes IS NULL OR incubation_minutes >= 0)")
        + add_constraint(table, f"ck_{short}_replicates", "CHECK (replicates >= 1)")
    )


SAMPLING = "ALTER TABLE lab.experiment ADD COLUMN IF NOT EXISTS sampling TEXT NOT NULL DEFAULT 'time_course';\n" + add_constraint(
    "lab.experiment", "ck_experiment_sampling", "CHECK (sampling IN ('time_course', 'endpoint'))"
)


def upgrade() -> None:
    op.execute(CREATE_EXTRA_TARGETS)
    op.execute(SAMPLING)
    op.execute(time_and_replicates("lab.experiment_modulator", "experiment_modulator"))
    op.execute(time_and_replicates("lab.experiment_control", "experiment_control"))


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE lab.experiment_control
            DROP CONSTRAINT IF EXISTS ck_experiment_control_replicates,
            DROP CONSTRAINT IF EXISTS ck_experiment_control_minutes,
            DROP COLUMN IF EXISTS replicates,
            DROP COLUMN IF EXISTS incubation_minutes;
        ALTER TABLE lab.experiment_modulator
            DROP CONSTRAINT IF EXISTS ck_experiment_modulator_replicates,
            DROP CONSTRAINT IF EXISTS ck_experiment_modulator_minutes,
            DROP COLUMN IF EXISTS replicates,
            DROP COLUMN IF EXISTS incubation_minutes;
        ALTER TABLE lab.experiment
            DROP CONSTRAINT IF EXISTS ck_experiment_sampling,
            DROP COLUMN IF EXISTS sampling;
        DROP TABLE IF EXISTS lab.experiment_modulator_extra_target;
        """
    )
