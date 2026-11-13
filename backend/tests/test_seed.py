import pytest
from sqlalchemy import Engine, create_engine, select, text
from sqlalchemy.orm import Session

from app.models import AssayMeasurement, Experiment
from app.seed.demo import NotADemoDatabase, NotEmpty, load_into_empty, reset
from tests.conftest import SERVER_URL


def test_reset_loads_the_demo_story(engine: Engine) -> None:
    assert reset(engine) == {"measurements": 72, "modulator_arms": 3, "donors": 10, "experiments": 3}
    with Session(engine) as session:
        story = session.scalars(select(Experiment).where(Experiment.experiment_code == "WL-2026-047")).one()
        rows = session.scalars(select(AssayMeasurement).where(AssayMeasurement.experiment_id == story.id)).all()

    assert {float(r.normalized_value) for r in rows if r.timepoint == 0} == {100.0}
    outlier = [r for r in rows if r.experiment_modulator_id is None and r.replicate_number == 3 and r.timepoint == 60]
    assert [float(r.normalized_value) for r in outlier] == [41.0]


def test_reset_is_repeatable(engine: Engine) -> None:
    assert reset(engine) == reset(engine)


def test_reset_refuses_a_database_that_is_not_a_demo() -> None:
    admin = create_engine(f"{SERVER_URL}/postgres")
    with pytest.raises(NotADemoDatabase):
        reset(admin)
    admin.dispose()


def test_load_into_empty_refuses_a_database_with_rows_and_fills_an_empty_one(engine: Engine) -> None:
    reset(engine)
    with pytest.raises(NotEmpty):
        load_into_empty(engine)

    with engine.begin() as conn:
        tables = conn.execute(text("SELECT 'lab.' || tablename FROM pg_tables WHERE schemaname = 'lab'")).scalars()
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    assert load_into_empty(engine) == {"measurements": 72, "modulator_arms": 3, "donors": 10, "experiments": 3}
