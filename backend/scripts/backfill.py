"""Bring rows an older build wrote after a migration, such as during a deploy, up to the current shape:
a primary stage and a stage for every measurement (0003), a vehicle control and a subject for every
control-arm row (0004). Each migration's own backfill SQL runs again, except that a vehicle is added
only to an experiment holding a row an older build wrote. All of it fills in only what is missing and
never touches what the current build wrote, so rerunning is safe. Component roles (0006) are filled once,
by their migration: a row without a role may be one the current build was sent without one.
    Usage: cd backend && uv run python -m scripts.backfill
"""

import importlib.util
from pathlib import Path

from sqlalchemy import Connection, text

from app.db import get_engine

VERSIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"


def _migration(name: str):
    spec = importlib.util.spec_from_file_location(f"migration_{name}", VERSIONS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def backfill(connection: Connection) -> dict[str, int]:
    stages = _migration("0003_experiment_stage")
    controls = _migration("0004_series_and_controls")
    connection.execute(text(stages.REFUSE_UNKNOWN_UNITS))
    counts = {
        "stages": connection.execute(text(stages.BACKFILL_STAGES)).rowcount,
        "measurement stages": connection.execute(text(stages.BACKFILL_MEASUREMENT_STAGES)).rowcount,
        "arm stages": connection.execute(text(controls.BACKFILL_ARM_STAGES)).rowcount,
        "vehicle controls": connection.execute(text(controls.REPAIR_CONTROLS)).rowcount,
    }
    counts["control subjects"] = sum(connection.execute(text(sql)).rowcount for sql in controls.REPAIR_SUBJECTS)
    return counts


def main() -> None:
    with get_engine().begin() as connection:
        counts = backfill(connection)
    print("; ".join(f"{name}: {count}" for name, count in counts.items()))


if __name__ == "__main__":
    main()
