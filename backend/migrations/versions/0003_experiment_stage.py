"""Stages: an experiment's incubations, each with its own time and protein, and a dilution link between them.

Every existing experiment gets one primary stage copied from its conditions row, and every existing
measurement is attributed to that stage. The conditions columns stay in place."""

from alembic import op

revision = "0003_experiment_stage"
down_revision = "0002_demo_essentials"

REFUSE_UNKNOWN_UNITS = """
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM lab.experiment_condition
    WHERE incubation_time IS NOT NULL
      AND lower(coalesce(incubation_time_unit, 'min')) NOT IN ('min', 'h', 's')
  ) THEN
    RAISE EXCEPTION 'experiment_condition has an incubation_time_unit other than min, h or s, which this migration cannot convert to minutes';
  END IF;
END $$
"""

CREATE_STAGE = """
CREATE TABLE IF NOT EXISTS lab.experiment_stage (
    id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id              BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    stage_type                 TEXT NOT NULL
                                   CONSTRAINT ck_experiment_stage_type CHECK (stage_type IN ('primary', 'secondary', 'tertiary')),
    sequence                   INTEGER NOT NULL CONSTRAINT ck_experiment_stage_sequence CHECK (sequence >= 1),
    incubation_minutes         NUMERIC CONSTRAINT ck_experiment_stage_minutes
                                   CHECK (incubation_minutes IS NULL OR incubation_minutes >= 0),
    protein_concentration      NUMERIC CONSTRAINT ck_experiment_stage_protein
                                   CHECK (protein_concentration IS NULL OR protein_concentration >= 0),
    protein_concentration_unit TEXT DEFAULT 'mg/mL',
    cell_density               NUMERIC CONSTRAINT ck_experiment_stage_cell_density
                                   CHECK (cell_density IS NULL OR cell_density >= 0),
    cell_density_unit          TEXT,
    dilution_factor            NUMERIC CONSTRAINT ck_experiment_stage_dilution
                                   CHECK (dilution_factor IS NULL OR dilution_factor > 0),
    diluted_from_stage_id      BIGINT,
    notes                      TEXT,
    CONSTRAINT uq_lab_expstage_type UNIQUE (experiment_id, stage_type),
    CONSTRAINT uq_lab_expstage_sequence UNIQUE (experiment_id, sequence),
    CONSTRAINT uq_lab_expstage_id_experiment UNIQUE (id, experiment_id),
    CONSTRAINT fk_lab_expstage_diluted_from FOREIGN KEY (diluted_from_stage_id, experiment_id)
        REFERENCES lab.experiment_stage (id, experiment_id),
    CONSTRAINT ck_experiment_stage_dilution_pair CHECK ((dilution_factor IS NULL) = (diluted_from_stage_id IS NULL)),
    CONSTRAINT ck_experiment_stage_not_self CHECK (diluted_from_stage_id IS NULL OR diluted_from_stage_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_lab_expstage_experiment ON lab.experiment_stage (experiment_id);
"""

BACKFILL_STAGES = """
INSERT INTO lab.experiment_stage (
    experiment_id, stage_type, sequence, incubation_minutes,
    protein_concentration, protein_concentration_unit, cell_density, cell_density_unit
)
SELECT e.id, 'primary', 1,
       CASE lower(coalesce(c.incubation_time_unit, 'min'))
           WHEN 'min' THEN c.incubation_time
           WHEN 'h' THEN c.incubation_time * 60
           WHEN 's' THEN c.incubation_time / 60
       END,
       c.protein_concentration, coalesce(c.protein_concentration_unit, 'mg/mL'), c.cell_density, c.cell_density_unit
FROM lab.experiment e
LEFT JOIN lab.experiment_condition c ON c.experiment_id = e.id
ON CONFLICT ON CONSTRAINT uq_lab_expstage_type DO NOTHING
"""

ADD_MEASUREMENT_STAGE = """
ALTER TABLE lab.assay_measurement ADD COLUMN IF NOT EXISTS stage_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lab_measurement_stage') THEN
    ALTER TABLE lab.assay_measurement ADD CONSTRAINT fk_lab_measurement_stage
        FOREIGN KEY (stage_id, experiment_id) REFERENCES lab.experiment_stage (id, experiment_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_lab_measurement_stage ON lab.assay_measurement (stage_id);
"""

BACKFILL_MEASUREMENT_STAGES = """
UPDATE lab.assay_measurement m
SET stage_id = s.id
FROM lab.experiment_stage s
WHERE s.experiment_id = m.experiment_id AND s.stage_type = 'primary' AND m.stage_id IS NULL
"""


def upgrade() -> None:
    op.execute(REFUSE_UNKNOWN_UNITS)
    op.execute(CREATE_STAGE)
    op.execute(BACKFILL_STAGES)
    op.execute(ADD_MEASUREMENT_STAGE)
    op.execute(BACKFILL_MEASUREMENT_STAGES)


def downgrade() -> None:
    op.execute("ALTER TABLE lab.assay_measurement DROP COLUMN IF EXISTS stage_id")
    op.execute("DROP TABLE IF EXISTS lab.experiment_stage")
