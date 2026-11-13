"""Controls as rows, several per stage, and arms that name their stage, cofactor state, and reference.

Every existing experiment's implicit control becomes one "Vehicle control" row on its primary stage, and
every measurement, result, and study sample that ran without a modulator points at it. Every existing arm
moves to its experiment's primary stage. Nothing that exists is changed or removed."""

from alembic import op

revision = "0004_series_and_controls"
down_revision = "0003_experiment_stage"

CONTROL_TYPES = "'vehicle', 'complete', 'minus_cofactor', 'minus_substrate', 'minus_protein', 'heat_inactivated', 'other'"


def add_constraint(table: str, name: str, definition: str) -> str:
    return f"""
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{name}') THEN
    ALTER TABLE {table} ADD CONSTRAINT {name} {definition};
  END IF;
END $$;
"""


COFACTOR_TARGET = add_constraint("lab.experiment_cofactor", "uq_lab_expcofactor_id_experiment", "UNIQUE (id, experiment_id)")

CREATE_CONTROL = f"""
CREATE TABLE IF NOT EXISTS lab.experiment_control (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id         BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    stage_id              BIGINT NOT NULL,
    control_type          TEXT NOT NULL CONSTRAINT ck_experiment_control_type CHECK (control_type IN ({CONTROL_TYPES})),
    label                 TEXT NOT NULL CONSTRAINT ck_experiment_control_label CHECK (btrim(label) <> ''),
    solvent               TEXT,
    solvent_percentage    NUMERIC CONSTRAINT ck_experiment_control_solvent_percentage
                              CHECK (solvent_percentage IS NULL OR solvent_percentage BETWEEN 0 AND 100),
    omitted_cofactor_id   BIGINT,
    protein_concentration NUMERIC CONSTRAINT ck_experiment_control_protein
                              CHECK (protein_concentration IS NULL OR protein_concentration >= 0),
    notes                 TEXT,
    CONSTRAINT fk_lab_expcontrol_stage FOREIGN KEY (stage_id, experiment_id)
        REFERENCES lab.experiment_stage (id, experiment_id) ON DELETE CASCADE,
    CONSTRAINT fk_lab_expcontrol_omitted_cofactor FOREIGN KEY (omitted_cofactor_id, experiment_id)
        REFERENCES lab.experiment_cofactor (id, experiment_id),
    CONSTRAINT ck_experiment_control_omitted_only_minus_cofactor
        CHECK (omitted_cofactor_id IS NULL OR control_type = 'minus_cofactor'),
    CONSTRAINT ck_experiment_control_complete_no_solvent
        CHECK (control_type <> 'complete' OR (solvent IS NULL AND solvent_percentage IS NULL)),
    CONSTRAINT ck_experiment_control_vehicle_names_solvent
        CHECK (control_type <> 'vehicle' OR solvent IS NULL OR lower(btrim(solvent)) <> 'none'),
    CONSTRAINT ck_experiment_control_protein_override
        CHECK (protein_concentration IS NULL OR control_type IN ('heat_inactivated', 'other')),
    CONSTRAINT uq_lab_expcontrol_id_experiment UNIQUE (id, experiment_id),
    CONSTRAINT uq_lab_expcontrol_id_experiment_stage UNIQUE (id, experiment_id, stage_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_expcontrol_label
    ON lab.experiment_control (experiment_id, stage_id, lower(btrim(label)));
CREATE INDEX IF NOT EXISTS idx_lab_expcontrol_experiment ON lab.experiment_control (experiment_id);
"""

ARM_COLUMNS = (
    """
ALTER TABLE lab.experiment_modulator
    ADD COLUMN IF NOT EXISTS stage_id             BIGINT,
    ADD COLUMN IF NOT EXISTS arm_label            TEXT,
    ADD COLUMN IF NOT EXISTS solvent              TEXT,
    ADD COLUMN IF NOT EXISTS solvent_percentage   NUMERIC,
    ADD COLUMN IF NOT EXISTS cofactor_omitted     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS omitted_cofactor_id  BIGINT,
    ADD COLUMN IF NOT EXISTS reference_control_id BIGINT;
"""
    + add_constraint(
        "lab.experiment_modulator",
        "ck_experiment_modulator_solvent_percentage",
        "CHECK (solvent_percentage IS NULL OR solvent_percentage BETWEEN 0 AND 100)",
    )
    + add_constraint(
        "lab.experiment_modulator",
        "fk_lab_expmod_stage",
        "FOREIGN KEY (stage_id, experiment_id) REFERENCES lab.experiment_stage (id, experiment_id)",
    )
    + add_constraint(
        "lab.experiment_modulator",
        "fk_lab_expmod_omitted_cofactor",
        "FOREIGN KEY (omitted_cofactor_id, experiment_id) REFERENCES lab.experiment_cofactor (id, experiment_id)",
    )
    + add_constraint(
        "lab.experiment_modulator",
        "ck_experiment_modulator_omitted_requires_flag",
        "CHECK (omitted_cofactor_id IS NULL OR cofactor_omitted)",
    )
    + add_constraint(
        "lab.experiment_modulator",
        "fk_lab_expmod_reference",
        "FOREIGN KEY (reference_control_id, experiment_id, stage_id) REFERENCES lab.experiment_control (id, experiment_id, stage_id)",
    )
    + """
CREATE INDEX IF NOT EXISTS idx_lab_expmod_stage ON lab.experiment_modulator (stage_id);
CREATE INDEX IF NOT EXISTS idx_lab_expmod_reference ON lab.experiment_modulator (reference_control_id);
"""
)

BACKFILL_ARM_STAGES = """
UPDATE lab.experiment_modulator m
SET stage_id = s.id
FROM lab.experiment_stage s
WHERE s.experiment_id = m.experiment_id AND s.stage_type = 'primary' AND m.stage_id IS NULL
"""

REQUIRE_ARM_STAGE = "ALTER TABLE lab.experiment_modulator ALTER COLUMN stage_id SET NOT NULL"

# Every added expression only separates rows the old index already allowed, so this cannot fail on existing data.
REPLACE_ARM_INDEX = """
DROP INDEX IF EXISTS lab.uq_lab_expmod_arm;
CREATE UNIQUE INDEX uq_lab_expmod_arm ON lab.experiment_modulator (
    experiment_id, stage_id, modulator_compound_id,
    COALESCE(modulator_role, ''), COALESCE(target_enzyme_id, -1),
    COALESCE(modulator_concentration, -1), COALESCE(concentration_unit, ''),
    COALESCE(reagent_lot_id, -1), cofactor_omitted, COALESCE(omitted_cofactor_id, -1)
);
"""


def subject_columns(table: str, short: str, check_prefix: str, reference: bool) -> str:
    sql = f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS experiment_control_id BIGINT;\n"
    if reference:
        sql += f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS reference_control_id BIGINT;\n"
    sql += add_constraint(
        table,
        f"fk_lab_{short}_control",
        "FOREIGN KEY (experiment_control_id, experiment_id) REFERENCES lab.experiment_control (id, experiment_id)",
    )
    if reference:
        sql += add_constraint(
            table,
            f"fk_lab_{short}_reference",
            "FOREIGN KEY (reference_control_id, experiment_id) REFERENCES lab.experiment_control (id, experiment_id)",
        )
    sql += add_constraint(
        table, f"ck_{check_prefix}_one_subject", "CHECK (experiment_modulator_id IS NULL OR experiment_control_id IS NULL)"
    )
    sql += f"CREATE INDEX IF NOT EXISTS idx_lab_{short}_control ON {table} (experiment_control_id);\n"
    return sql


SUBJECTS = (
    subject_columns("lab.assay_measurement", "measurement", "assay_measurement", reference=False)
    + subject_columns("lab.substrate_depletion_result", "sdr", "sdr", reference=True)
    + subject_columns("lab.metabolite_formation_result", "mfr", "mfr", reference=True)
    + subject_columns("lab.lcms_sample", "lcms_sample", "lcms_sample", reference=False)
    + add_constraint(
        "lab.lcms_sample", "ck_lcms_sample_control_has_experiment", "CHECK (experiment_control_id IS NULL OR experiment_id IS NOT NULL)"
    )
)

# Postgres lets CREATE OR REPLACE VIEW only append columns, so the control goes last.
STUDY_RESULT_VIEW = """
CREATE OR REPLACE VIEW lab.v_lcms_study_result AS
SELECT
    e.id                        AS experiment_id,
    e.experiment_code,
    e.study_type,
    s.experiment_modulator_id,
    s.replicate_number,
    s.timepoint,
    s.timepoint_unit,
    s.substrate_concentration,
    s.substrate_concentration_unit,
    ma.analyte_label,
    ma.analyte_role,
    ma.compound_id,
    ma.metabolite_id,
    p.peak_area,
    p.area_ratio,
    p.calculated_concentration,
    p.dilution_corrected_concentration,
    p.concentration_unit,
    p.retention_time,
    p.signal_to_noise,
    p.is_below_lloq,
    p.integration_type,
    p.is_excluded                AS peak_excluded,
    s.is_excluded                AS sample_excluded,
    p.assay_measurement_id,
    i.acquisition_file,
    i.acquired_at,
    b.batch_code,
    b.batch_status,
    m.method_code,
    m.version                    AS method_version,
    s.experiment_control_id
FROM lab.lcms_peak p
JOIN lab.lcms_injection i        ON i.id = p.injection_id
JOIN lab.lcms_batch b            ON b.id = i.batch_id
JOIN lab.lcms_method m           ON m.id = b.method_id
JOIN lab.lcms_method_analyte ma  ON ma.id = p.method_analyte_id
JOIN lab.lcms_sample s           ON s.id = i.sample_id
JOIN lab.experiment e            ON e.id = s.experiment_id
WHERE s.sample_type = 'study'
"""

PRIMARY_VEHICLE = """
    SELECT c.id, c.experiment_id
    FROM lab.experiment_control c
    JOIN lab.experiment_stage s ON s.id = c.stage_id AND s.stage_type = 'primary'
    WHERE c.control_type = 'vehicle' AND c.label = 'Vehicle control'
"""

BACKFILL_CONTROLS = """
INSERT INTO lab.experiment_control (experiment_id, stage_id, control_type, label)
SELECT s.experiment_id, s.id, 'vehicle', 'Vehicle control'
FROM lab.experiment_stage s
WHERE s.stage_type = 'primary'
  AND NOT EXISTS (SELECT 1 FROM lab.experiment_control c WHERE c.experiment_id = s.experiment_id)
"""

# Only an older build writes a measurement or a result with neither an arm nor a control: the new build
# gives every row it writes one of the two. The repair keys on that, so it never touches an experiment the
# new build wrote, such as one created with no controls on purpose or a result saved with no reference.
OLDER_BUILD_ROWS = """
    SELECT experiment_id FROM lab.assay_measurement
    WHERE experiment_modulator_id IS NULL AND experiment_control_id IS NULL
    UNION
    SELECT experiment_id FROM lab.substrate_depletion_result
    WHERE experiment_modulator_id IS NULL AND experiment_control_id IS NULL
    UNION
    SELECT experiment_id FROM lab.metabolite_formation_result
    WHERE experiment_modulator_id IS NULL AND experiment_control_id IS NULL
"""

REPAIR_CONTROLS = BACKFILL_CONTROLS + f"  AND s.experiment_id IN ({OLDER_BUILD_ROWS})\n"

MEASUREMENT_SUBJECTS = f"""
UPDATE lab.assay_measurement m SET experiment_control_id = v.id
FROM ({PRIMARY_VEHICLE}) v
WHERE v.experiment_id = m.experiment_id AND m.experiment_modulator_id IS NULL AND m.experiment_control_id IS NULL
"""

STUDY_SAMPLE_SUBJECTS = f"""
UPDATE lab.lcms_sample s SET experiment_control_id = v.id
FROM ({PRIMARY_VEHICLE}) v
WHERE s.sample_type = 'study' AND v.experiment_id = s.experiment_id
  AND s.experiment_modulator_id IS NULL AND s.experiment_control_id IS NULL
"""

RESULT_TABLES = ("substrate_depletion_result", "metabolite_formation_result")


def result_subjects(table: str, only_older_saves: bool) -> str:
    """Every result row without a reference gets the vehicle as its reference, and the vehicle's own row gets it as
    its subject. When the migration runs, every row was written by an older build, including an arm-only save whose
    vehicle had no fit. The repair runs later, beside rows the current build saved without a reference on purpose,
    so it touches only a save that holds a row with neither subject, which only an older build writes. Postgres
    evaluates that EXISTS against the rows as they were before the statement, so a whole save updates together."""
    older_save = f"""
  AND r.experiment_control_id IS NULL
  AND EXISTS (
      SELECT 1 FROM lab.{table} older
      WHERE older.experiment_id = r.experiment_id
        AND older.experiment_modulator_id IS NULL AND older.experiment_control_id IS NULL
  )"""
    return f"""
UPDATE lab.{table} r
SET experiment_control_id = CASE WHEN r.experiment_modulator_id IS NULL THEN v.id END,
    reference_control_id = v.id
FROM ({PRIMARY_VEHICLE}) v
WHERE v.experiment_id = r.experiment_id
  AND r.reference_control_id IS NULL{older_save if only_older_saves else ""}
"""


BACKFILL_SUBJECTS = [MEASUREMENT_SUBJECTS, *(result_subjects(t, only_older_saves=False) for t in RESULT_TABLES), STUDY_SAMPLE_SUBJECTS]
REPAIR_SUBJECTS = [MEASUREMENT_SUBJECTS, *(result_subjects(t, only_older_saves=True) for t in RESULT_TABLES), STUDY_SAMPLE_SUBJECTS]


def upgrade() -> None:
    op.execute(COFACTOR_TARGET)
    op.execute(CREATE_CONTROL)
    op.execute(ARM_COLUMNS)
    op.execute(BACKFILL_ARM_STAGES)
    op.execute(REQUIRE_ARM_STAGE)
    op.execute(REPLACE_ARM_INDEX)
    op.execute(SUBJECTS)
    op.execute(STUDY_RESULT_VIEW)
    op.execute(BACKFILL_CONTROLS)
    for statement in BACKFILL_SUBJECTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP VIEW lab.v_lcms_study_result")
    op.execute(STUDY_RESULT_VIEW.replace("CREATE OR REPLACE VIEW", "CREATE VIEW").replace(",\n    s.experiment_control_id", ""))
    for table in ("lab.assay_measurement", "lab.substrate_depletion_result", "lab.metabolite_formation_result", "lab.lcms_sample"):
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS reference_control_id, DROP COLUMN IF EXISTS experiment_control_id")
    op.execute(
        """
        DROP INDEX IF EXISTS lab.uq_lab_expmod_arm;
        CREATE UNIQUE INDEX uq_lab_expmod_arm ON lab.experiment_modulator (
            experiment_id, modulator_compound_id, COALESCE(modulator_role, ''), COALESCE(target_enzyme_id, -1),
            COALESCE(modulator_concentration, -1), COALESCE(concentration_unit, ''), COALESCE(reagent_lot_id, -1)
        )
        """
    )
    op.execute(
        "ALTER TABLE lab.experiment_modulator DROP COLUMN IF EXISTS reference_control_id, DROP COLUMN IF EXISTS omitted_cofactor_id,"
        " DROP COLUMN IF EXISTS cofactor_omitted, DROP COLUMN IF EXISTS solvent_percentage, DROP COLUMN IF EXISTS solvent,"
        " DROP COLUMN IF EXISTS arm_label, DROP COLUMN IF EXISTS stage_id"
    )
    op.execute("DROP TABLE IF EXISTS lab.experiment_control")
    op.execute("ALTER TABLE lab.experiment_cofactor DROP CONSTRAINT IF EXISTS uq_lab_expcofactor_id_experiment")
