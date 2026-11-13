import csv
import io
import math
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import app
from app.models import AssayMeasurement, Experiment, ExperimentStage
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}
PRIMARY = {"stage_type": "primary", "incubation_minutes": 30, "protein_concentration": 0.5}
SECONDARY = {
    "stage_type": "secondary",
    "incubation_minutes": 10,
    "protein_concentration": 0.05,
    "dilution_factor": 10,
    "diluted_from": "primary",
}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def _create(client: TestClient, **fields) -> dict:
    body = {"title": "Gemfibrozil glucuronide dilution", "study_type": "chemical_inhibition", "substrate": "amodiaquine"} | fields
    return client.post("/api/experiments", json=body, headers=FETCH)


def test_two_stages_are_stored_as_two_rows(client: TestClient) -> None:
    created = _create(client, stages=[PRIMARY, SECONDARY], condition={"fu_inc": 0.9})
    assert created.status_code == 201
    stages = created.json()["stages"]
    assert [(s["stage_type"], s["incubation_minutes"], s["protein_concentration"]) for s in stages] == [
        ("primary", 30, 0.5),
        ("secondary", 10, 0.05),
    ]
    assert stages[1]["diluted_from"] == "primary" and stages[1]["dilution_factor"] == 10
    assert stages[1]["derived_protein_concentration"] == pytest.approx(0.05)
    assert created.json()["warnings"] == []
    condition = created.json()["condition"]
    assert (condition["incubation_time"], condition["protein_concentration"]) == (30, 0.5)


def test_a_dilution_that_disagrees_warns_but_still_saves(client: TestClient) -> None:
    created = _create(client, stages=[PRIMARY, SECONDARY | {"protein_concentration": 0.08}])
    assert created.status_code == 201
    assert created.json()["stages"][1]["derived_protein_concentration"] == pytest.approx(0.05)
    assert created.json()["warnings"] == [
        "Secondary stage: 0.08 mg/mL entered, but 0.5 mg/mL diluted 10-fold gives 0.05 mg/mL."
    ]


def test_a_request_without_stages_gets_one_primary_stage_from_its_condition(client: TestClient) -> None:
    created = _create(client, condition={"incubation_time": 45, "protein_concentration": 1.0})
    assert created.status_code == 201
    assert [(s["stage_type"], s["incubation_minutes"], s["protein_concentration"]) for s in created.json()["stages"]] == [
        ("primary", 45, 1.0)
    ]


@pytest.mark.parametrize(
    ("stages", "message"),
    [
        ([], "at least 1 item"),
        ([SECONDARY], "stages must run primary, then secondary, then tertiary"),
        ([PRIMARY, PRIMARY], "stages must run primary, then secondary, then tertiary"),
        ([PRIMARY, SECONDARY | {"diluted_from": None}], "a dilution needs both its factor and the stage it was diluted from"),
        ([PRIMARY, SECONDARY | {"diluted_from": "secondary"}], "the secondary stage can only be diluted from a stage before it"),
    ],
)
def test_stages_out_of_shape_are_refused(client: TestClient, stages: list[dict], message: str) -> None:
    refused = _create(client, stages=stages)
    assert refused.status_code == 422
    assert message in refused.text


def test_condition_values_beside_stages_are_refused(client: TestClient) -> None:
    refused = _create(client, stages=[PRIMARY], condition={"protein_concentration": 0.5})
    assert refused.status_code == 422
    assert "give incubation time, protein and cell density on the stages" in refused.text


def _paste(client: TestClient, url: str, times=(0, 5, 10), rate=0.02, **body) -> None:
    columns = client.get(f"{url}/measurements").json()["template_columns"]
    lines = ["\t".join(columns)] + [
        "\t".join([str(t)] + [f"{100 * math.exp(-rate * t):.4f}"] * (len(columns) - 1)) for t in times
    ]
    preview = client.post(f"{url}/measurements/paste-preview", json={"text": "\n".join(lines)}, headers=FETCH).json()
    saved = client.put(f"{url}/measurements", json={"rows": preview["rows"], "substrate_concentration": 1} | body, headers=FETCH)
    assert saved.status_code == 200, saved.text


def test_a_diluted_stage_without_its_own_protein_uses_the_derived_value(client: TestClient) -> None:
    blank = {key: value for key, value in SECONDARY.items() if key != "protein_concentration"}
    experiment = _create(client, stages=[PRIMARY, blank], condition={"fu_inc": 0.9}).json()
    url = f"/api/experiments/{experiment['id']}"
    _paste(client, url)
    result = client.get(f"{url}/depletion").json()
    assert result["protein_mg_per_ml"] == pytest.approx(0.05)
    control = next(a for a in result["arms"] if a["kind"] == "control")
    assert control["fit"]["clint_app"] == pytest.approx(0.02 * 1000 / 0.05, rel=1e-3)
    assert result["fu_inc"] == 0.9 and result["fu_inc_withheld"] is True


def test_a_re_paste_keeps_the_stage_of_the_rows_it_replaces(client: TestClient) -> None:
    experiment = _create(client, stages=[PRIMARY, SECONDARY]).json()
    url = f"/api/experiments/{experiment['id']}"
    assert client.get(f"{url}/measurements").json()["stage"] is None
    _paste(client, url, stage="primary")
    assert client.get(f"{url}/measurements").json()["stage"] == "primary"
    _paste(client, url, rate=0.03)
    assert client.get(f"{url}/measurements").json()["stage"] == "primary"
    assert client.get(f"{url}/depletion").json()["protein_mg_per_ml"] == pytest.approx(0.5)


def _sample_experiment_url(client: TestClient) -> str:
    experiment = next(e for e in client.get("/api/experiments").json() if e["code"] == "WL-2026-047")
    return f"/api/experiments/{experiment['id']}"


def _fits(result: dict) -> dict:
    return {arm["label"]: (arm["fit"], arm["inhibition"]) for arm in result["arms"]}


def test_points_without_a_stage_analyse_like_the_primary_stage(client: TestClient, engine: Engine) -> None:
    url = _sample_experiment_url(client)
    before = client.get(f"{url}/depletion").json()
    with Session(engine) as session:
        session.execute(update(AssayMeasurement).values(stage_id=None))
        session.commit()
    after = client.get(f"{url}/depletion").json()
    assert _fits(after) == _fits(before) and after["problems"] == before["problems"]


def test_points_that_span_two_stages_are_not_scaled(client: TestClient, engine: Engine) -> None:
    experiment = _create(client, stages=[PRIMARY, SECONDARY]).json()
    url = f"/api/experiments/{experiment['id']}"
    _paste(client, url, stage="primary")
    with Session(engine) as session:
        secondary = session.scalar(
            select(ExperimentStage.id).where(
                ExperimentStage.experiment_id == experiment["id"], ExperimentStage.stage_type == "secondary"
            )
        )
        first = session.scalar(select(func.min(AssayMeasurement.id)).where(AssayMeasurement.experiment_id == experiment["id"]))
        session.execute(update(AssayMeasurement).where(AssayMeasurement.id == first).values(stage_id=secondary))
        session.commit()
    result = client.get(f"{url}/depletion").json()
    assert result["protein_mg_per_ml"] is None
    assert any("more than one stage" in problem for problem in result["problems"])
    assert client.get(f"{url}/measurements").json()["stage"] is None


def test_pasted_samples_go_to_the_last_stage_and_use_its_protein(client: TestClient) -> None:
    experiment = _create(client, stages=[PRIMARY, SECONDARY], condition={"fu_inc": 0.9}).json()
    url = f"/api/experiments/{experiment['id']}"
    columns = client.get(f"{url}/measurements").json()["template_columns"]
    times = (0, 5, 10)
    lines = ["\t".join(columns)] + [
        "\t".join([str(t)] + [f"{100 * math.exp(-0.02 * t):.4f}"] * (len(columns) - 1)) for t in times
    ]
    preview = client.post(f"{url}/measurements/paste-preview", json={"text": "\n".join(lines)}, headers=FETCH).json()
    assert client.put(f"{url}/measurements", json={"rows": preview["rows"], "substrate_concentration": 1}, headers=FETCH).status_code == 200

    result = client.get(f"{url}/depletion").json()
    assert result["protein_mg_per_ml"] == pytest.approx(0.05)
    control = next(a for a in result["arms"] if a["kind"] == "control")
    assert control["fit"]["clint_app"] == pytest.approx(0.02 * 1000 / 0.05, rel=1e-3)
    assert control["fit"]["clint_u"] is None
    assert any("fu,inc was measured at the primary stage" in problem for problem in result["problems"])


def test_a_paste_can_name_its_stage(client: TestClient, engine: Engine) -> None:
    experiment = _create(client, stages=[PRIMARY, SECONDARY]).json()
    url = f"/api/experiments/{experiment['id']}"
    columns = client.get(f"{url}/measurements").json()["template_columns"]
    width = len(columns) - 1
    lines = ["\t".join(columns)] + ["\t".join([str(t)] + [str(value)] * width) for t, value in ((0, 100), (5, 90), (10, 80))]
    preview = client.post(f"{url}/measurements/paste-preview", json={"text": "\n".join(lines)}, headers=FETCH).json()
    saved = client.put(f"{url}/measurements", json={"rows": preview["rows"], "substrate_concentration": 1, "stage": "primary"}, headers=FETCH)
    assert saved.status_code == 200
    with Session(engine) as session:
        stage_types = set(
            session.scalars(
                select(ExperimentStage.stage_type)
                .join(AssayMeasurement, AssayMeasurement.stage_id == ExperimentStage.id)
                .where(AssayMeasurement.experiment_id == experiment["id"])
            )
        )
    assert stage_types == {"primary"}
    assert client.put(f"{url}/measurements", json={"rows": preview["rows"], "stage": "tertiary"}, headers=FETCH).status_code == 422


def _experiment(session: Session) -> Experiment:
    experiment = Experiment(study_type="substrate_depletion", title="constraint check")
    session.add(experiment)
    session.flush()
    return experiment


def _stage(session: Session, experiment: Experiment, **fields) -> ExperimentStage:
    stage = ExperimentStage(experiment_id=experiment.id, **({"stage_type": "primary", "sequence": 1} | fields))
    session.add(stage)
    session.flush()
    return stage


def test_a_bad_stage_type_is_rejected(session: Session) -> None:
    with pytest.raises(IntegrityError, match="ck_experiment_stage_type"):
        _stage(session, _experiment(session), stage_type="quaternary")


def test_a_second_primary_stage_is_rejected(session: Session) -> None:
    experiment = _experiment(session)
    _stage(session, experiment)
    with pytest.raises(IntegrityError, match="uq_lab_expstage_type"):
        _stage(session, experiment, sequence=2)


def test_a_half_set_dilution_is_rejected(session: Session) -> None:
    with pytest.raises(IntegrityError, match="ck_experiment_stage_dilution_pair"):
        _stage(session, _experiment(session), dilution_factor=10)


def test_a_dilution_from_another_experiments_stage_is_rejected(session: Session) -> None:
    elsewhere = _stage(session, _experiment(session))
    experiment = _experiment(session)
    with pytest.raises(IntegrityError, match="fk_lab_expstage_diluted_from"):
        _stage(session, experiment, dilution_factor=10, diluted_from_stage_id=elsewhere.id)


def test_a_tertiary_dilution_scales_analysis_and_export_through_a_blank_secondary(client: TestClient) -> None:
    secondary = SECONDARY | {"protein_concentration": None}
    tertiary = {
        "stage_type": "tertiary", "incubation_minutes": 10,
        "dilution_factor": 10, "diluted_from": "secondary",
    }
    created = _create(client, stages=[PRIMARY, secondary, tertiary])
    assert created.status_code == 201, created.text
    assert created.json()["stages"][2]["derived_protein_concentration"] == pytest.approx(0.005)
    url = f"/api/experiments/{created.json()['id']}"
    _paste(client, url, rate=0.02)
    result = client.get(f"{url}/depletion").json()
    assert result["protein_mg_per_ml"] == pytest.approx(0.005)
    assert all(arm["fit"]["clint_app"] == pytest.approx(4000, rel=1e-5) for arm in result["arms"])
    rows = list(csv.DictReader(io.StringIO(client.get(f"{url}/export.csv").content.decode("utf-8-sig"))))
    assert {row["sampled_protein"] for row in rows} == {"0.005"}


def test_zero_protein_in_a_diluted_stage_does_not_produce_clint(client: TestClient) -> None:
    created = _create(client, stages=[PRIMARY, SECONDARY | {"protein_concentration": 0}])
    assert created.status_code == 201, created.text
    url = f"/api/experiments/{created.json()['id']}"
    _paste(client, url)
    result = client.get(f"{url}/depletion").json()
    assert result["protein_mg_per_ml"] == 0
    assert all(arm["fit"]["clint_app"] is None for arm in result["arms"])
    assert all("must be positive" in arm["fit"]["problem"] for arm in result["arms"])
