"""What each component of an incubation is for, the solutions they were prepared in, and regenerating systems.

An experiment's component rows (the table keeps its old name, experiment_cofactor) gain a role: solvent,
cofactor, substrate or other. A row gets a role only where its lot's reagent is typed as one of the first
three; every other row stays unclassified rather than becoming a cofactor by default. A component can cite
the prepared solution it came from, which records who made it, when, and in what buffer. A new reagent type,
regenerating_system, lists components on each of its lots, so Solution A and Solution B each carry theirs and
each batch names the lots it was made from. Nothing that exists changes but the reagent type check, which only
widens."""

from alembic import op

revision = "0006_components_and_solutions"
down_revision = "0005_internal_standard"

REAGENT_TYPES = (
    "'substrate', 'inhibitor', 'inducer', 'probe_substrate', 'cofactor', 'solvent', 'buffer', 'internal_standard', 'other'"
)
COMPONENT_ROLES = "'solvent', 'cofactor', 'substrate', 'other'"


def add_constraint(table: str, name: str, definition: str) -> str:
    return f"""
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{name}') THEN
    ALTER TABLE {table} ADD CONSTRAINT {name} {definition};
  END IF;
END $$;
"""


# The old check is unnamed; its replacement takes a name so its message can be found. Every value the old
# check allowed, the new one allows too, so this cannot fail on existing rows.
WIDEN_REAGENT_TYPE = "ALTER TABLE lab.reagent DROP CONSTRAINT IF EXISTS reagent_reagent_type_check;\n" + add_constraint(
    "lab.reagent", "ck_reagent_type", f"CHECK (reagent_type IN ({REAGENT_TYPES}, 'regenerating_system'))"
)

# Each lot of a regenerating system lists its own components, since a batch is made from its own lots of each.
CREATE_COMPONENTS = """
CREATE TABLE IF NOT EXISTS lab.reagent_component (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reagent_lot_id    BIGINT NOT NULL REFERENCES lab.reagent_lot(id) ON DELETE CASCADE,
    component_name    TEXT NOT NULL CONSTRAINT ck_reagent_component_name CHECK (btrim(component_name) <> ''),
    amount            NUMERIC CONSTRAINT ck_reagent_component_amount CHECK (amount IS NULL OR amount >= 0),
    amount_unit       TEXT,
    component_lot_id  BIGINT REFERENCES lab.reagent_lot(id),
    CONSTRAINT ck_reagent_component_unit CHECK (amount IS NULL OR amount_unit IS NOT NULL),
    CONSTRAINT ck_reagent_component_not_itself CHECK (component_lot_id IS NULL OR component_lot_id <> reagent_lot_id)
);
CREATE INDEX IF NOT EXISTS idx_lab_reagent_component_lot ON lab.reagent_component (reagent_lot_id);
"""

CREATE_SOLUTIONS = """
CREATE TABLE IF NOT EXISTS lab.prepared_solution (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label               TEXT NOT NULL CONSTRAINT ck_prepared_solution_label CHECK (btrim(label) <> ''),
    prepared_by         BIGINT REFERENCES lab.lab_member(id),
    prepared_on         DATE,
    buffer_composition  TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

COMPONENT_COLUMNS = (
    """
ALTER TABLE lab.experiment_cofactor
    ADD COLUMN IF NOT EXISTS component_role       TEXT,
    ADD COLUMN IF NOT EXISTS prepared_solution_id BIGINT;
"""
    + add_constraint(
        "lab.experiment_cofactor",
        "ck_experiment_cofactor_role",
        f"CHECK (component_role IS NULL OR component_role IN ({COMPONENT_ROLES}))",
    )
    + add_constraint(
        "lab.experiment_cofactor",
        "fk_lab_expcofactor_solution",
        "FOREIGN KEY (prepared_solution_id) REFERENCES lab.prepared_solution (id)",
    )
    + "CREATE INDEX IF NOT EXISTS idx_lab_expcofactor_solution ON lab.experiment_cofactor (prepared_solution_id);\n"
)

# Only a lot whose reagent is typed solvent, cofactor or substrate says what its row is for.
BACKFILL_ROLES = """
UPDATE lab.experiment_cofactor c
SET component_role = r.reagent_type
FROM lab.reagent_lot l
JOIN lab.reagent r ON r.id = l.reagent_id
WHERE l.id = c.reagent_lot_id
  AND c.component_role IS NULL
  AND r.reagent_type IN ('solvent', 'cofactor', 'substrate')
"""


def upgrade() -> None:
    op.execute(WIDEN_REAGENT_TYPE)
    op.execute(CREATE_COMPONENTS)
    op.execute(CREATE_SOLUTIONS)
    op.execute(COMPONENT_COLUMNS)
    op.execute(BACKFILL_ROLES)


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE lab.experiment_cofactor
            DROP CONSTRAINT IF EXISTS fk_lab_expcofactor_solution,
            DROP CONSTRAINT IF EXISTS ck_experiment_cofactor_role,
            DROP COLUMN IF EXISTS prepared_solution_id,
            DROP COLUMN IF EXISTS component_role;
        DROP TABLE IF EXISTS lab.prepared_solution;
        DROP TABLE IF EXISTS lab.reagent_component;
        ALTER TABLE lab.reagent DROP CONSTRAINT IF EXISTS ck_reagent_type;
        """
        + f"ALTER TABLE lab.reagent ADD CONSTRAINT reagent_reagent_type_check CHECK (reagent_type IN ({REAGENT_TYPES}));"
    )
