"""An experiment's internal standard: the compound added to every sample to normalise the LC-MS signal, the
step it is added at and in what, and the lot it came from. It is a table of its own, so it can never count
as an arm or a control. Nothing that exists changes."""

from alembic import op

revision = "0005_internal_standard"
down_revision = "0004_series_and_controls"

ADDITION_STEPS = "'reaction_termination', 'sample_preparation', 'reconstitution', 'other'"

CREATE_INTERNAL_STANDARD = f"""
CREATE TABLE IF NOT EXISTS lab.experiment_internal_standard (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id       BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    compound_id         BIGINT NOT NULL REFERENCES lab.compound(id),
    concentration       NUMERIC CONSTRAINT ck_internal_standard_concentration
                            CHECK (concentration IS NULL OR concentration > 0),
    concentration_unit  TEXT,
    addition_step       TEXT NOT NULL DEFAULT 'reaction_termination'
                            CONSTRAINT ck_internal_standard_addition_step CHECK (addition_step IN ({ADDITION_STEPS})),
    solvent             TEXT DEFAULT 'ice-cold acetonitrile',
    reagent_lot_id      BIGINT REFERENCES lab.reagent_lot(id),
    notes               TEXT,
    CONSTRAINT ck_internal_standard_unit CHECK (concentration IS NULL OR concentration_unit IS NOT NULL),
    CONSTRAINT uq_lab_expis_experiment UNIQUE (experiment_id)
);
"""


def upgrade() -> None:
    op.execute(CREATE_INTERNAL_STANDARD)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS lab.experiment_internal_standard")
