import json
import math
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.db import get_engine
from app.main import app
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}
GOLDEN = json.loads((Path(__file__).parent / "golden" / "wl_2026_047_depletion.json").read_text())


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def _without_saved(result: dict) -> dict:
    return {key: value for key, value in result.items() if key != "saved"}


# Arm keys changed form on purpose when controls became rows ('control' became 'ctl-<id>').
IGNORED = {"key"}


def assert_holds(expected, actual, path: str = "result") -> None:
    """Every value in the golden file must be present and equal, floats to 12 significant digits. Fields
    added to the response since the file was captured are allowed; a changed or missing value is not."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected an object"
        for key, value in expected.items():
            if key in IGNORED:
                continue
            assert key in actual, f"{path}.{key}: missing"
            assert_holds(value, actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{path}: expected {len(expected)} items"
        for index, (want, got) in enumerate(zip(expected, actual, strict=True)):
            assert_holds(want, got, f"{path}[{index}]")
    elif isinstance(expected, float) and isinstance(actual, float):
        # NumPy's float sums can differ in the last bit with memory alignment; any real change is far larger.
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-15), f"{path}: {actual!r} != {expected!r}"
    else:
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"


def test_the_sample_analysis_matches_the_pre_revision_numbers_exactly(client: TestClient) -> None:
    """The golden file was captured from the code before stages existed. Any change to a fit, an
    inhibition, an fm, a point, or a problem line shows up here, to full float precision."""
    experiment = next(e for e in client.get("/api/experiments").json() if e["code"] == "WL-2026-047")
    url = f"/api/experiments/{experiment['id']}/depletion"
    with_outlier = client.get(url).json()
    assert_holds(GOLDEN["with_outlier"], _without_saved(with_outlier))

    control = next(a for a in with_outlier["arms"] if a["kind"] == "control")
    outlier = next(p for p in control["points"] if p["replicate"] == 3 and p["timepoint"] == 60)
    without_outlier = client.post(f"{url}/preview", json={"excluded_ids": [outlier["measurement_id"]]}, headers=FETCH).json()
    assert_holds(GOLDEN["without_outlier"], _without_saved(without_outlier))
