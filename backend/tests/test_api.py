from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import app
from app.models import SubstrateDepletionResult
from app.seed.data import PERCENT_REMAINING, TIMEPOINTS_MIN
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def story_id(client: TestClient) -> int:
    return next(e["id"] for e in client.get("/api/experiments").json() if e["code"] == "WL-2026-047")


def outlier_id(client: TestClient, experiment_id: int) -> int:
    measurements = client.get(f"/api/experiments/{experiment_id}/measurements").json()
    control = next(a["key"] for a in measurements["arms"] if a["kind"] == "control")
    return next(r["id"] for r in measurements["rows"] if r["arm_key"] == control and r["replicate"] == 3 and r["timepoint"] == 60)


def arm(result: dict, label: str) -> dict:
    return next(a for a in result["arms"] if a["label"] == label)


def test_health_reports_the_database(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok", "database": "wetlab_test", "version": "dev", "demo": False}


def test_dashboard_flags_the_expiring_and_low_lots(client: TestClient) -> None:
    dashboard = client.get("/api/dashboard").json()
    flags = {alert["lot_number"]: alert["flags"] for alert in dashboard["lot_alerts"]}
    statuses = {s["status"]: s["count"] for s in dashboard["experiments_by_status"]}

    assert {"KTZ-25088", "NAD-25610"} <= set(flags)
    assert "low_stock" in flags["NAD-25610"]
    assert statuses["completed"] == statuses["in_progress"] == statuses["planned"] == 1


def test_experiment_detail_tells_the_provenance_story(client: TestClient) -> None:
    detail = client.get(f"/api/experiments/{story_id(client)}").json()
    kinds = {a["label"]: a["kind"] for a in detail["arms"]}

    assert kinds == {
        "Vehicle control": "control",
        "montelukast": "inhibitor",
        "ketoconazole": "inhibitor",
        "quinidine": "selectivity_control",
    }
    assert len(detail["protocol"]["steps"]) == 8
    assert detail["condition"]["protein_concentration"] == 0.5
    assert detail["substrate_concentrations"] == [{"value": 1.0, "unit": "uM"}]
    assert detail["tissue"]["lot_number"] == "HLM10-2606" and detail["tissue"]["valid_at_use"]
    assert detail["cofactors"][0]["lot"]["lot_number"] == "NAD-25610"


def test_excluding_the_outlier_moves_clint_and_fm(client: TestClient) -> None:
    experiment_id = story_id(client)
    url = f"/api/experiments/{experiment_id}/depletion/preview"
    included = client.post(url, json={"excluded_ids": []}, headers=FETCH).json()
    excluded = client.post(url, json={"excluded_ids": [outlier_id(client, experiment_id)]}, headers=FETCH).json()

    assert arm(included, "Vehicle control")["fit"]["clint_app"] == pytest.approx(49.6, abs=0.3)
    assert arm(excluded, "Vehicle control")["fit"]["clint_app"] == pytest.approx(56.0, abs=0.3)
    assert arm(excluded, "montelukast")["inhibition"]["fm_apparent"] == pytest.approx(0.64, abs=0.01)
    assert arm(excluded, "montelukast")["fit"]["half_life_extrapolated"]
    quinidine = arm(excluded, "quinidine")["inhibition"]
    assert not quinidine["significant"] and quinidine["fm_apparent"] is None
    assert excluded["saved"] is None


def test_save_records_the_reason_and_the_results(client: TestClient, engine: Engine) -> None:
    experiment_id = story_id(client)
    outlier = outlier_id(client, experiment_id)
    saved = client.post(
        f"/api/experiments/{experiment_id}/depletion/save",
        json={"exclusions": [{"measurement_id": outlier, "reason": "carryover"}]},
        headers=FETCH,
    )
    assert saved.status_code == 200
    reloaded = client.get(f"/api/experiments/{experiment_id}/depletion").json()
    point = next(p for p in arm(reloaded, "Vehicle control")["points"] if p["measurement_id"] == outlier)

    assert point["excluded"] and point["exclusion_reason"] == "carryover"
    assert reloaded["saved"]["computed_by"] == "Wet Lab demo user"
    with Session(engine) as session:
        rows = session.scalars(
            select(SubstrateDepletionResult).where(SubstrateDepletionResult.experiment_id == experiment_id)
        ).all()
    assert len(rows) == 4
    montelukast = next(r for r in rows if r.fm_basis and "CYP2C8" in r.fm_basis)
    assert float(montelukast.fm_estimate) == pytest.approx(0.64, abs=0.01)
    assert all(r.value_unit == "uL/min/mg protein" for r in rows)


def test_an_exclusion_without_a_known_reason_is_rejected(client: TestClient) -> None:
    experiment_id = story_id(client)
    response = client.post(
        f"/api/experiments/{experiment_id}/depletion/save",
        json={"exclusions": [{"measurement_id": outlier_id(client, experiment_id), "reason": "looked odd"}]},
        headers=FETCH,
    )
    assert response.status_code == 422


def test_changes_without_the_fetch_header_are_refused(client: TestClient) -> None:
    response = client.post(f"/api/experiments/{story_id(client)}/depletion/preview", json={"excluded_ids": []})
    assert response.status_code == 403


def test_measurements_from_another_experiment_are_rejected(client: TestClient) -> None:
    experiments = client.get("/api/experiments").json()
    other = next(e["id"] for e in experiments if e["code"] == "WL-2026-051")
    response = client.post(
        f"/api/experiments/{other}/depletion/preview",
        json={"excluded_ids": [outlier_id(client, story_id(client))]},
        headers=FETCH,
    )
    assert response.status_code == 422


def test_pasting_an_excel_block_replaces_the_data(client: TestClient) -> None:
    experiment_id = story_id(client)
    client.post(f"/api/experiments/{experiment_id}/depletion/save", json={"exclusions": []}, headers=FETCH)
    columns = client.get(f"/api/experiments/{experiment_id}/measurements").json()["template_columns"]
    arms_in_order = ("control", "montelukast", "ketoconazole", "quinidine")
    lines = ["\t".join(columns)] + [
        "\t".join([str(t)] + [str(PERCENT_REMAINING[a][i][r]) for a in arms_in_order for r in range(3)])
        for i, t in enumerate(TIMEPOINTS_MIN)
    ]

    preview = client.post(
        f"/api/experiments/{experiment_id}/measurements/paste-preview",
        json={"text": "\n".join(lines), "value_kind": "percent_of_t0"},
        headers=FETCH,
    ).json()
    assert preview["errors"] == [] and preview["warnings"] == []
    assert len(preview["rows"]) == 72

    replaced = client.put(
        f"/api/experiments/{experiment_id}/measurements",
        json={"rows": preview["rows"], "value_kind": "percent_of_t0"},
        headers=FETCH,
    )
    assert replaced.status_code == 200 and len(replaced.json()["rows"]) == 72
    assert client.get(f"/api/experiments/{experiment_id}/depletion").json()["saved"] is None


def test_non_finite_numbers_are_rejected(client: TestClient) -> None:
    experiment_id = story_id(client)
    columns = client.get(f"/api/experiments/{experiment_id}/measurements").json()["template_columns"]
    row = "\t".join(["0"] + ["nan"] + ["100"] * (len(columns) - 2))
    preview = client.post(
        f"/api/experiments/{experiment_id}/measurements/paste-preview",
        json={"text": row},
        headers=FETCH,
    ).json()
    assert any("'nan' is not a number" in error for error in preview["errors"])

    infinite = client.put(
        f"/api/experiments/{experiment_id}/measurements",
        content='{"rows": [{"arm_key": "control", "replicate": 1, "timepoint": 1e999, "percent_of_t0": 100}]}',
        headers={**FETCH, "Content-Type": "application/json"},
    )
    assert infinite.status_code == 422


def test_a_ragged_paste_explains_the_expected_layout(client: TestClient) -> None:
    response = client.post(
        f"/api/experiments/{story_id(client)}/measurements/paste-preview",
        json={"text": "0\t100\t99\n5\t90\t91"},
        headers=FETCH,
    ).json()
    assert response["rows"] == []
    assert "Copy the template" in response["errors"][0]


def test_duplicate_time_course_measurements_are_rejected_without_changing_saved_data(client: TestClient) -> None:
    url = f"/api/experiments/{story_id(client)}/measurements"
    before = client.get(url).json()
    arm = before["arms"][0]["key"]
    row = {"arm_key": arm, "replicate": 1, "timepoint": 0, "percent_of_t0": 100}
    refused = client.put(url, json={"rows": [row, row | {"percent_of_t0": 200}]}, headers=FETCH)
    assert refused.status_code == 422
    assert "condition, replicate and timepoint" in refused.json()["detail"]
    assert client.get(url).json()["rows"] == before["rows"]
