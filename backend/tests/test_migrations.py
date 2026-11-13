"""Migrations run against databases that already hold rows, which the empty test database never exercises."""

import importlib.util
from collections.abc import Iterator

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, create_engine, text

from tests.conftest import BACKEND, SERVER_URL

SCRATCH = "wetlab_migration_test"
SCRATCH_URL = f"{SERVER_URL}/{SCRATCH}"


def _load_migration(name: str):
    spec = importlib.util.spec_from_file_location(name, BACKEND / "migrations" / "versions" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migrate(revision: str) -> None:
    config = Config(str(BACKEND / "alembic.ini"))
    config.attributes["url"] = SCRATCH_URL
    config.attributes["configure_logger"] = False
    command.upgrade(config, revision)


@pytest.fixture
def scratch() -> Iterator[Connection]:
    admin = create_engine(f"{SERVER_URL}/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {SCRATCH} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {SCRATCH}"))
    engine = create_engine(SCRATCH_URL)
    try:
        with engine.connect() as connection:
            yield connection
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {SCRATCH} WITH (FORCE)"))
        admin.dispose()


def _insert(connection: Connection, sql: str, **params) -> int:
    return connection.execute(text(sql), params).scalar_one()


def _experiment(connection: Connection, code: str, study_type: str = "substrate_depletion") -> int:
    return _insert(
        connection,
        "INSERT INTO lab.experiment (experiment_code, study_type) VALUES (:code, :study_type) RETURNING id",
        code=code,
        study_type=study_type,
    )


def _condition(connection: Connection, experiment_id: int, **fields) -> None:
    columns = ", ".join(["experiment_id", *fields])
    values = ", ".join([":experiment_id", *(f":{name}" for name in fields)])
    connection.execute(text(f"INSERT INTO lab.experiment_condition ({columns}) VALUES ({values})"), {"experiment_id": experiment_id} | fields)


def test_every_legacy_experiment_gets_one_primary_stage_and_keeps_its_values(scratch: Connection) -> None:
    _migrate("0002_demo_essentials")
    legacy = _experiment(scratch, "WL-LEGACY-1")
    _condition(scratch, legacy, incubation_time=60, protein_concentration=0.5)
    bare = _experiment(scratch, "WL-LEGACY-2")
    hours = _experiment(scratch, "WL-LEGACY-3")
    _condition(scratch, hours, incubation_time=2, incubation_time_unit="h", protein_concentration=1.0)
    cells = _experiment(scratch, "WL-LEGACY-4", "hepatocyte_stability")
    _condition(scratch, cells, incubation_time=120, cell_density=0.5, cell_density_unit="10^6 cells/mL")
    seconds = _experiment(scratch, "WL-LEGACY-5")
    _condition(scratch, seconds, incubation_time=90, incubation_time_unit="s")
    no_unit = _experiment(scratch, "WL-LEGACY-6")
    _condition(scratch, no_unit, incubation_time=30, incubation_time_unit=None)
    for replicate in (1, 2, 3):
        scratch.execute(
            text(
                "INSERT INTO lab.assay_measurement (experiment_id, replicate_number, timepoint, measured_entity, normalized_value)"
                " VALUES (:experiment_id, :replicate, 0, 'parent_remaining', 100)"
            ),
            {"experiment_id": legacy, "replicate": replicate},
        )
    scratch.commit()

    _migrate("0003_experiment_stage")

    stages = {
        row.experiment_id: row
        for row in scratch.execute(
            text(
                "SELECT experiment_id, stage_type, sequence, incubation_minutes, protein_concentration,"
                " cell_density, cell_density_unit FROM lab.experiment_stage"
            )
        )
    }
    assert set(stages) == {legacy, bare, hours, cells, seconds, no_unit}
    assert all((row.stage_type, row.sequence) == ("primary", 1) for row in stages.values())
    assert (stages[legacy].incubation_minutes, stages[legacy].protein_concentration) == (60, 0.5)
    assert (stages[bare].incubation_minutes, stages[bare].protein_concentration) == (None, None)
    assert stages[hours].incubation_minutes == 120
    assert stages[seconds].incubation_minutes == 1.5
    assert stages[no_unit].incubation_minutes == 30
    assert (stages[cells].cell_density, stages[cells].cell_density_unit, stages[cells].protein_concentration) == (
        0.5,
        "10^6 cells/mL",
        None,
    )
    measurement_stages = scratch.execute(text("SELECT DISTINCT stage_id FROM lab.assay_measurement")).scalars().all()
    primary_of_legacy = scratch.execute(
        text("SELECT id FROM lab.experiment_stage WHERE experiment_id = :id"), {"id": legacy}
    ).scalar_one()
    assert measurement_stages == [primary_of_legacy]

    migration = _load_migration("0003_experiment_stage")
    before = scratch.execute(text("SELECT count(*) FROM lab.experiment_stage")).scalar_one()
    scratch.execute(text(migration.BACKFILL_STAGES))
    scratch.execute(text(migration.BACKFILL_MEASUREMENT_STAGES))
    after = scratch.execute(text("SELECT count(*) FROM lab.experiment_stage")).scalar_one()
    assert before == after == 6


def test_the_repair_brings_rows_an_older_build_wrote_after_the_migrations_up_to_date(scratch: Connection) -> None:
    from scripts.backfill import backfill

    _migrate("head")
    late = _experiment(scratch, "WL-LATE-1")
    _condition(scratch, late, incubation_time=45, protein_concentration=0.5)
    scratch.execute(
        text(
            "INSERT INTO lab.assay_measurement (experiment_id, replicate_number, timepoint, measured_entity, normalized_value)"
            " VALUES (:id, 1, 0, 'parent_remaining', 100)"
        ),
        {"id": late},
    )
    nadph = _insert(scratch, "INSERT INTO lab.reagent (name, reagent_type) VALUES ('NADPH', 'cofactor') RETURNING id")
    lot = _insert(scratch, "INSERT INTO lab.reagent_lot (reagent_id, lot_number) VALUES (:reagent, 'N-1') RETURNING id", reagent=nadph)
    component = _insert(
        scratch,
        "INSERT INTO lab.experiment_cofactor (experiment_id, cofactor, reagent_lot_id) VALUES (:id, 'NADPH', :lot) RETURNING id",
        id=late,
        lot=lot,
    )
    assert backfill(scratch) == {
        "stages": 1,
        "measurement stages": 1,
        "arm stages": 0,
        "vehicle controls": 1,
        "control subjects": 1,
    }
    role = scratch.execute(text("SELECT component_role FROM lab.experiment_cofactor WHERE id = :id"), {"id": component}).scalar_one()
    assert role is None, "the repair leaves roles alone: the current build may have saved this row without one"
    stage = scratch.execute(
        text("SELECT id, incubation_minutes, protein_concentration FROM lab.experiment_stage WHERE experiment_id = :id"),
        {"id": late},
    ).one()
    assert (stage.incubation_minutes, stage.protein_concentration) == (45, 0.5)
    vehicle = scratch.execute(
        text("SELECT id, stage_id, label FROM lab.experiment_control WHERE experiment_id = :id"), {"id": late}
    ).one()
    assert (vehicle.stage_id, vehicle.label) == (stage.id, "Vehicle control")
    measurement = scratch.execute(
        text("SELECT stage_id, experiment_control_id FROM lab.assay_measurement WHERE experiment_id = :id"), {"id": late}
    ).one()
    assert (measurement.stage_id, measurement.experiment_control_id) == (stage.id, vehicle.id)
    assert set(backfill(scratch).values()) == {0}


def test_legacy_controls_become_one_vehicle_row_that_every_control_row_points_at(scratch: Connection) -> None:
    _migrate("0002_demo_essentials")
    legacy = _experiment(scratch, "WL-LEGACY-C")
    _condition(scratch, legacy, incubation_time=60, protein_concentration=0.5, solvent="DMSO")
    compound = _insert(scratch, "INSERT INTO lab.compound (canonical_name) VALUES ('ketoconazole') RETURNING id")
    arm = _insert(
        scratch,
        "INSERT INTO lab.experiment_modulator (experiment_id, modulator_compound_id, modulator_concentration, concentration_unit)"
        " VALUES (:id, :compound, 1, 'uM') RETURNING id",
        id=legacy,
        compound=compound,
    )
    killed = _insert(
        scratch,
        "INSERT INTO lab.experiment_modulator (experiment_id, modulator_compound_id, control_type)"
        " VALUES (:id, :compound, 'heat_inactivated') RETURNING id",
        id=legacy,
        compound=_insert(scratch, "INSERT INTO lab.compound (canonical_name) VALUES ('boiled microsomes') RETURNING id"),
    )
    for modulator in (None, arm):
        scratch.execute(
            text(
                "INSERT INTO lab.assay_measurement (experiment_id, experiment_modulator_id, replicate_number, timepoint, measured_entity, normalized_value)"
                " VALUES (:id, :modulator, 1, 0, 'parent_remaining', 100)"
            ),
            {"id": legacy, "modulator": modulator},
        )
        scratch.execute(
            text("INSERT INTO lab.substrate_depletion_result (experiment_id, experiment_modulator_id) VALUES (:id, :modulator)"),
            {"id": legacy, "modulator": modulator},
        )
    study = _insert(
        scratch,
        "INSERT INTO lab.lcms_sample (sample_code, sample_type, experiment_id) VALUES ('S-1', 'study', :id) RETURNING id",
        id=legacy,
    )
    calibrator = _insert(
        scratch,
        "INSERT INTO lab.lcms_sample (sample_code, sample_type, nominal_concentration) VALUES ('C-1', 'calibrator', 1) RETURNING id",
    )
    # An older build saved only its arms when the vehicle had no fit.
    arm_only = _experiment(scratch, "WL-LEGACY-D")
    _condition(scratch, arm_only, incubation_time=30, protein_concentration=0.5)
    lone_arm = _insert(
        scratch,
        "INSERT INTO lab.experiment_modulator (experiment_id, modulator_compound_id, modulator_concentration, concentration_unit)"
        " VALUES (:id, :compound, 1, 'uM') RETURNING id",
        id=arm_only,
        compound=compound,
    )
    scratch.execute(
        text("INSERT INTO lab.substrate_depletion_result (experiment_id, experiment_modulator_id) VALUES (:id, :modulator)"),
        {"id": arm_only, "modulator": lone_arm},
    )
    scratch.commit()

    _migrate("0004_series_and_controls")

    vehicle = scratch.execute(
        text(
            "SELECT c.id, c.label, c.control_type, s.stage_type FROM lab.experiment_control c"
            " JOIN lab.experiment_stage s ON s.id = c.stage_id WHERE c.experiment_id = :id"
        ),
        {"id": legacy},
    ).one()
    assert (vehicle.label, vehicle.control_type, vehicle.stage_type) == ("Vehicle control", "vehicle", "primary")
    subjects = dict(
        scratch.execute(
            text("SELECT experiment_modulator_id, experiment_control_id FROM lab.assay_measurement WHERE experiment_id = :id"),
            {"id": legacy},
        ).all()
    )
    assert subjects == {None: vehicle.id, arm: None}
    results = scratch.execute(
        text(
            "SELECT experiment_modulator_id, experiment_control_id, reference_control_id FROM lab.substrate_depletion_result"
            " WHERE experiment_id = :id ORDER BY experiment_modulator_id NULLS FIRST"
        ),
        {"id": legacy},
    ).all()
    assert [tuple(row) for row in results] == [(None, vehicle.id, vehicle.id), (arm, None, vehicle.id)]
    samples = dict(scratch.execute(text("SELECT id, experiment_control_id FROM lab.lcms_sample")).all())
    assert samples == {study: vehicle.id, calibrator: None}
    assert scratch.execute(text("SELECT control_type FROM lab.experiment_modulator WHERE id = :id"), {"id": killed}).scalar_one() == (
        "heat_inactivated"
    )
    assert scratch.execute(text("SELECT count(*) FROM lab.experiment_modulator WHERE stage_id IS NULL")).scalar_one() == 0
    lone_vehicle = scratch.execute(text("SELECT id FROM lab.experiment_control WHERE experiment_id = :id"), {"id": arm_only}).scalar_one()
    lone_result = scratch.execute(
        text("SELECT experiment_control_id, reference_control_id FROM lab.substrate_depletion_result WHERE experiment_id = :id"),
        {"id": arm_only},
    ).one()
    assert tuple(lone_result) == (None, lone_vehicle)

    from scripts.backfill import backfill

    before = _snapshot(scratch)
    assert set(backfill(scratch).values()) == {0}
    assert _snapshot(scratch) == before


def _snapshot(connection: Connection) -> dict[str, list]:
    tables = connection.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname = 'lab' ORDER BY tablename")).all()
    snapshot = {table: sorted(map(tuple, connection.execute(text(f'SELECT * FROM lab."{table}"')).all()), key=repr) for table in tables}
    connection.rollback()
    return snapshot


def test_the_repair_never_changes_what_the_current_build_wrote(scratch: Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    """Designs whose saved rows carry no reference, and one created with no controls at all: a later setup run's
    repair must leave every one of their rows as the app wrote it."""
    from fastapi.testclient import TestClient

    from app.db import get_engine
    from app.main import app
    from app.seed.demo import reset
    from scripts.backfill import backfill

    _migrate("head")
    monkeypatch.setenv("DATABASE_URL", SCRATCH_URL)
    get_engine.cache_clear()
    reset(get_engine())
    fetch = {"X-Requested-With": "wetlab"}
    nadph = {"cofactor": "NADPH", "concentration": 1, "concentration_unit": "mM"}
    designs = [
        # The secondary stage's minus-NADPH control has no reference in its stage.
        {
            "stages": [{"stage_type": "primary"}, {"stage_type": "secondary"}],
            "cofactors": [nadph],
            "controls": [{"stage": "primary", "control_type": "vehicle"}, {"stage": "secondary", "control_type": "minus_cofactor"}],
        },
        # Quinidine in methanol matches neither vehicle; the twin has no minus-cofactor control.
        {
            "condition": {"solvent": "DMSO"},
            "cofactors": [nadph],
            "controls": [{"control_type": "vehicle", "solvent": "DMSO"}, {"control_type": "vehicle", "solvent": "acetonitrile"}],
            "arms": [
                {"inhibitor": "quinidine", "concentration": 1, "solvent": "methanol"},
                {"inhibitor": "ketoconazole", "concentration": 1, "cofactor_omitted": True},
            ],
        },
        # No controls on purpose.
        {"controls": [], "arms": [{"inhibitor": "ketoconazole", "concentration": 1}]},
    ]
    with TestClient(app) as client:
        for index, design in enumerate(designs):
            body = {"title": f"repair check {index}", "study_type": "chemical_inhibition", "substrate": "amodiaquine"} | design
            created = client.post("/api/experiments", json=body, headers=fetch)
            assert created.status_code == 201, created.text
            url = f"/api/experiments/{created.json()['id']}"
            arms = client.get(f"{url}/measurements").json()["arms"]
            rows = [
                {"arm_key": arm["key"], "replicate": 1, "timepoint": t, "percent_of_t0": value}
                for arm in arms
                for t, value in ((0, 100), (30, 70), (60, 50))
            ]
            assert client.put(f"{url}/measurements", json={"rows": rows, "substrate_concentration": 1}, headers=fetch).status_code == 200
            assert client.post(f"{url}/depletion/save", json={"exclusions": []}, headers=fetch).status_code == 200
    get_engine.cache_clear()

    before = _snapshot(scratch)
    assert set(backfill(scratch).values()) == {0}
    assert _snapshot(scratch) == before

def _downgrade(revision: str) -> None:
    config = Config(str(BACKEND / "alembic.ini"))
    config.attributes["url"] = SCRATCH_URL
    config.attributes["configure_logger"] = False
    command.downgrade(config, revision)


def _row_counts(connection: Connection) -> dict[str, int]:
    """Rows in every lab table, read in a transaction that ends before any migration runs."""
    tables = connection.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname = 'lab' ORDER BY tablename")).all()
    counts = {table: connection.execute(text(f'SELECT count(*) FROM lab."{table}"')).scalar_one() for table in tables}
    connection.rollback()
    return counts


def test_the_internal_standard_table_arrives_empty_and_a_downgrade_leaves_no_trace(scratch: Connection) -> None:
    _migrate("0004_series_and_controls")
    legacy = _experiment(scratch, "WL-LEGACY-IS")
    _condition(scratch, legacy, incubation_time=30, protein_concentration=0.5)
    scratch.commit()
    before = _row_counts(scratch)

    _migrate("0005_internal_standard")
    assert _row_counts(scratch) == before | {"experiment_internal_standard": 0}
    _downgrade("0004_series_and_controls")
    assert _row_counts(scratch) == before
    _migrate("0005_internal_standard")
    assert _row_counts(scratch) == before | {"experiment_internal_standard": 0}


def test_components_get_a_role_only_from_a_lot_that_says_what_they_are(scratch: Connection) -> None:
    _migrate("0005_internal_standard")
    legacy = _experiment(scratch, "WL-LEGACY-R")

    def component(name: str, reagent_type: str | None) -> int:
        lot = None
        if reagent_type is not None:
            reagent = _insert(scratch, "INSERT INTO lab.reagent (name, reagent_type) VALUES (:name, :type) RETURNING id", name=name, type=reagent_type)
            lot = _insert(scratch, "INSERT INTO lab.reagent_lot (reagent_id, lot_number) VALUES (:reagent, :lot) RETURNING id", reagent=reagent, lot=f"{name}-1")
        return _insert(
            scratch,
            "INSERT INTO lab.experiment_cofactor (experiment_id, cofactor, reagent_lot_id) VALUES (:id, :name, :lot) RETURNING id",
            id=legacy,
            name=name,
            lot=lot,
        )

    rows = {
        "NADPH": component("NADPH", "cofactor"),
        "DMSO": component("DMSO", "solvent"),
        "midazolam": component("midazolam", "substrate"),
        "ketoconazole": component("ketoconazole", "inhibitor"),
        "buffer": component("buffer", "buffer"),
        "no lot": component("no lot", None),
    }
    scratch.commit()
    before = _row_counts(scratch)

    _migrate("0006_components_and_solutions")
    roles = dict(scratch.execute(text("SELECT cofactor, component_role FROM lab.experiment_cofactor WHERE experiment_id = :id"), {"id": legacy}).all())
    assert roles == {"NADPH": "cofactor", "DMSO": "solvent", "midazolam": "substrate", "ketoconazole": None, "buffer": None, "no lot": None}
    assert _row_counts(scratch) == before | {"reagent_component": 0, "prepared_solution": 0}
    scratch.execute(text("INSERT INTO lab.reagent (name, reagent_type) VALUES ('Solution A', 'regenerating_system')"))
    scratch.rollback()
    assert set(rows) == set(roles)


def test_a_legacy_experiment_exports_after_the_migrations(scratch: Connection) -> None:
    import csv
    import io

    from sqlalchemy.orm import Session

    from app.services.export import COLUMNS, experiment_csv

    _migrate("0002_demo_essentials")
    legacy = _experiment(scratch, "WL-LEGACY-X")
    _condition(scratch, legacy, incubation_time=1, incubation_time_unit="h", protein_concentration=0.5)
    compound = _insert(scratch, "INSERT INTO lab.compound (canonical_name) VALUES ('ketoconazole') RETURNING id")
    arm = _insert(
        scratch,
        "INSERT INTO lab.experiment_modulator (experiment_id, modulator_compound_id, modulator_concentration, concentration_unit)"
        " VALUES (:id, :compound, 1, 'uM') RETURNING id",
        id=legacy,
        compound=compound,
    )
    for modulator in (None, arm):
        for time, value in ((0, 100), (30, 60)):
            scratch.execute(
                text(
                    "INSERT INTO lab.assay_measurement (experiment_id, experiment_modulator_id, replicate_number, timepoint, measured_entity, normalized_value)"
                    " VALUES (:id, :modulator, 1, :time, 'parent_remaining', :value)"
                ),
                {"id": legacy, "modulator": modulator, "time": time, "value": value},
            )
    scratch.commit()

    _migrate("head")
    with Session(bind=scratch) as session:
        name, body = experiment_csv(session, legacy)
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"), newline="")))
    assert name == "WL-LEGACY-X-measurements.csv"
    assert list(rows[0]) == COLUMNS and len(rows) == 4
    assert [(row["series_label"], row["kind"], row["stage_sampled"]) for row in rows] == [
        ("Vehicle control", "control", "primary"),
        ("Vehicle control", "control", "primary"),
        ("ketoconazole", "inhibitor", "primary"),
        ("ketoconazole", "inhibitor", "primary"),
    ]
    assert {row["reference_label"] for row in rows[2:]} == {"Vehicle control"}
    assert {(row["sampled_protein"], row["time"]) for row in rows[:2]} == {("0.5", "0"), ("0.5", "30")}


def test_logins_start_with_nobody_able_to_sign_in_and_stop_on_emails_that_differ_only_by_case(scratch: Connection) -> None:
    _migrate("0006_components_and_solutions")
    scratch.execute(text("INSERT INTO lab.lab_member (full_name, email, role) VALUES ('Kim', 'kim@example.org', 'PI'), ('Kim again', 'KIM@example.org', NULL)"))
    scratch.commit()
    with pytest.raises(Exception, match="differs only by case.*kim@example.org, KIM@example.org"):
        _migrate("0007_logins")
    scratch.rollback()

    scratch.execute(text("UPDATE lab.lab_member SET email = 'kim2@example.org' WHERE full_name = 'Kim again'"))
    scratch.commit()
    _migrate("0007_logins")
    rows = scratch.execute(
        text("SELECT full_name, email, role, password_hash, is_admin, session_version FROM lab.lab_member ORDER BY id")
    ).all()
    assert [tuple(r) for r in rows] == [
        ("Kim", "kim@example.org", "PI", None, False, 0),
        ("Kim again", "kim2@example.org", None, None, False, 0),
    ]


def _columns(connection: Connection, table: str) -> set[str]:
    names = connection.scalars(
        text("SELECT column_name FROM information_schema.columns WHERE table_schema = 'lab' AND table_name = :table"), {"table": table}
    ).all()
    connection.rollback()
    return set(names)


ENDPOINT_COLUMNS = {
    "experiment": {"sampling"},
    "experiment_modulator": {"incubation_minutes", "replicates"},
    "experiment_control": {"incubation_minutes", "replicates"},
}


def test_legacy_rows_become_time_courses_at_their_stage_s_time_and_a_downgrade_leaves_no_trace(scratch: Connection) -> None:
    _migrate("0007_logins")
    legacy = _experiment(scratch, "WL-LEGACY-TARGETS")
    stage = _insert(scratch, "INSERT INTO lab.experiment_stage (experiment_id, stage_type, sequence) VALUES (:id, 'primary', 1) RETURNING id", id=legacy)
    compound = _insert(scratch, "INSERT INTO lab.compound (canonical_name) VALUES ('ketoconazole') RETURNING id")
    scratch.execute(
        text("INSERT INTO lab.experiment_modulator (experiment_id, stage_id, modulator_compound_id) VALUES (:id, :stage, :compound)"),
        {"id": legacy, "stage": stage, "compound": compound},
    )
    scratch.execute(
        text("INSERT INTO lab.experiment_control (experiment_id, stage_id, control_type, label) VALUES (:id, :stage, 'vehicle', 'Vehicle control')"),
        {"id": legacy, "stage": stage},
    )
    scratch.commit()
    before = _row_counts(scratch)
    columns_before = {table: _columns(scratch, table) for table in ENDPOINT_COLUMNS}

    _migrate("0008_endpoint_inhibition")
    assert _row_counts(scratch) == before | {"experiment_modulator_extra_target": 0}
    assert scratch.execute(text("SELECT sampling FROM lab.experiment WHERE id = :id"), {"id": legacy}).scalar_one() == "time_course"
    for table in ("experiment_modulator", "experiment_control"):
        assert scratch.execute(text(f"SELECT incubation_minutes, replicates FROM lab.{table}")).one() == (None, 3)
    scratch.rollback()
    _downgrade("0007_logins")
    assert _row_counts(scratch) == before
    assert {table: _columns(scratch, table) for table in ENDPOINT_COLUMNS} == columns_before
    _migrate("0008_endpoint_inhibition")
    assert _row_counts(scratch) == before | {"experiment_modulator_extra_target": 0}
    assert {table: _columns(scratch, table) - columns_before[table] for table in ENDPOINT_COLUMNS} == ENDPOINT_COLUMNS
