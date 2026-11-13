from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import app
from app.models import Experiment
from app.schemas import ExperimentIn
from app.seed.demo import reset
from app.services.experiments import DESIGN_TABLES

FETCH = {"X-Requested-With": "wetlab"}

# A design with every part the form can set: single-endpoint sampling, two stages with a dilution, a component, a
# labelled vehicle and minus-cofactor control in each stage, a series run longer than its stage, a twin without the
# cofactor with fewer replicates, an explicit reference, an inhibitor with a second target, an internal standard and
# pathways. Controls come in stage order, as the form sends them.
FULL = {
    "code": "WL-EDIT-1",
    "title": "A design to edit",
    "study_type": "chemical_inhibition",
    "experiment_date": "2026-11-12",
    "substrate": "amodiaquine",
    "objective": "Check the design comes back exactly.",
    "sampling": "endpoint",
    "condition": {"incubation_temperature": 37, "buffer": "phosphate", "ph": 7.4, "solvent": "DMSO", "solvent_percentage": 0.1},
    "stages": [
        {"stage_type": "primary", "incubation_minutes": 5, "protein_concentration": 0.5},
        {"stage_type": "secondary", "incubation_minutes": 10, "protein_concentration": 0.05, "dilution_factor": 10, "diluted_from": "primary"},
    ],
    "cofactors": [{"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM"}],
    "controls": [
        {
            "stage": "primary",
            "control_type": "vehicle",
            "label": "DMSO vehicle",
            "solvent": "DMSO",
            "solvent_percentage": 0.1,
            "incubation_minutes": 30,
        },
        {"stage": "primary", "control_type": "minus_cofactor", "label": "Minus NADPH", "omitted_cofactor": 0, "replicates": 1},
        {"stage": "secondary", "control_type": "vehicle", "label": "Vehicle after dilution"},
    ],
    "arms": [
        *(
            {"inhibitor": "gemfibrozil glucuronide", "target_enzyme": "CYP2C8", "concentration": c, "reference_control": 0, "incubation_minutes": 30}
            for c in (10, 30)
        ),
        *(
            {
                "inhibitor": "gemfibrozil glucuronide",
                "target_enzyme": "CYP2C8",
                "concentration": c,
                "cofactor_omitted": True,
                "omitted_cofactor": 0,
                "reference_control": 1,
                "incubation_minutes": 30,
                "replicates": 1,
            }
            for c in (10, 30)
        ),
        {
            "inhibitor": "ketoconazole",
            "target_enzyme": "CYP3A4",
            "also_targets": ["CYP3A5"],
            "concentration": 1,
            "stage": "secondary",
            "solvent": "none",
        },
    ],
    "pathways": [{"enzyme": "CYP2C8", "pathway_role": "major"}, {"enzyme": "CYP3A4", "pathway_role": "minor"}],
    "internal_standard": {"compound": "D3-imatinib", "concentration": 50, "concentration_unit": "nM"},
}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def _create(client: TestClient, body: dict) -> dict:
    response = client.post("/api/experiments", json=body, headers=FETCH)
    assert response.status_code == 201, response.text
    return response.json()


def _design(client: TestClient, experiment_id: int) -> dict:
    response = client.get(f"/api/experiments/{experiment_id}/design")
    assert response.status_code == 200, response.text
    return response.json()


def _as_request(body: dict) -> dict:
    """The body as the API reads it, with every default filled in."""
    return ExperimentIn.model_validate(body).model_dump(mode="json")


def test_a_saved_design_comes_back_as_the_request_that_wrote_it(client: TestClient) -> None:
    created = _create(client, FULL)
    back = _design(client, created["id"])
    assert back == _as_request(FULL | {"performed_by": created["performed_by_id"]})
    assert created["sampling"] == "endpoint"


def test_saving_a_design_unchanged_changes_nothing_but_row_ids(client: TestClient) -> None:
    created = _create(client, FULL)
    before = _design(client, created["id"])
    saved = client.put(f"/api/experiments/{created['id']}/design", json=before, headers=FETCH)
    assert saved.status_code == 200, saved.text
    assert _design(client, created["id"]) == before
    labels = lambda detail: [(arm["label"], arm["kind"], arm["stage"]) for arm in detail["arms"]]  # noqa: E731
    assert labels(saved.json()) == labels(created)


def test_a_design_without_bench_data_takes_new_arms_and_inhibitors(client: TestClient, engine: Engine) -> None:
    created = _create(client, FULL)
    edited = _design(client, created["id"])
    edited["arms"][4]["inhibitor"] = "itraconazole"
    edited["arms"].append({"inhibitor": "montelukast", "target_enzyme": "CYP2C8", "concentration": 3})
    edited["title"] = "A design, edited"
    saved = client.put(f"/api/experiments/{created['id']}/design", json=edited, headers=FETCH)
    assert saved.status_code == 200, saved.text
    detail = saved.json()
    assert (detail["id"], detail["code"], detail["status"], detail["title"]) == (created["id"], "WL-EDIT-1", "planned", "A design, edited")
    labels = {arm["label"] for arm in detail["arms"]}
    assert {"itraconazole (secondary)", "montelukast (primary)"} <= labels and "ketoconazole (secondary)" not in labels
    with Session(engine) as session:
        counts = {
            table.__tablename__: session.scalar(select(func.count()).select_from(table).where(table.experiment_id == created["id"]))
            for table in DESIGN_TABLES
        }
    assert counts == {
        "experiment_modulator": 6,
        "experiment_control": 3,
        "experiment_cofactor": 1,
        "experiment_stage": 2,
        "experiment_enzyme": 2,
        "experiment_internal_standard": 1,
        "experiment_condition": 1,
    }


def test_an_inhibitor_reads_back_every_target_and_is_an_inhibitor_when_any_target_is_expected(client: TestClient) -> None:
    created = _create(
        client,
        {
            "title": "Two targets",
            "study_type": "chemical_inhibition",
            "substrate": "tucatinib",
            "arms": [
                {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "also_targets": ["CYP3A5"], "concentration": 1},
                {"inhibitor": "quinidine", "target_enzyme": "CYP2D6", "concentration": 1},
            ],
            "pathways": [{"enzyme": "CYP3A5", "pathway_role": "major"}],
        },
    )
    arms = {arm["label"]: arm for arm in created["arms"] if arm["modulator_id"] is not None}
    assert (arms["ketoconazole"]["target_enzyme"], arms["ketoconazole"]["target_enzymes"]) == ("CYP3A4", ["CYP3A4", "CYP3A5"])
    assert (arms["ketoconazole"]["kind"], arms["quinidine"]["kind"]) == ("inhibitor", "selectivity_control")
    assert arms["quinidine"]["target_enzymes"] == ["CYP2D6"]


def test_a_lot_of_another_compound_is_refused_on_edit_too(client: TestClient) -> None:
    created = _create(client, FULL)
    ketoconazole_lot = next(lot["id"] for lot in client.get("/api/inventory/reagent-lots").json() if lot["lot_number"] == "KTZ-25088")
    edited = _design(client, created["id"])
    edited["arms"][0]["reagent_lot_id"] = ketoconazole_lot
    refused = client.put(f"/api/experiments/{created['id']}/design", json=edited, headers=FETCH)
    assert refused.status_code == 422 and "ketoconazole" in refused.json()["detail"]
    assert _design(client, created["id"])["arms"][0]["reagent_lot_id"] is None


def test_bench_data_fixes_the_design_but_not_the_details(client: TestClient, engine: Engine) -> None:
    with Session(engine) as session:
        story = session.scalar(select(Experiment.id).where(Experiment.experiment_code == "WL-2026-047"))
    detail = client.get(f"/api/experiments/{story}").json()
    assert detail["has_bench_data"] is True
    design = _design(client, story)
    refused = client.put(f"/api/experiments/{story}/design", json=design, headers=FETCH)
    assert refused.status_code == 409 and "bench data" in refused.json()["detail"]

    changed = client.patch(f"/api/experiments/{story}", json={"title": "Renamed", "objective": None}, headers=FETCH)
    assert changed.status_code == 200
    assert (changed.json()["title"], changed.json()["objective"]) == ("Renamed", None)
    assert changed.json()["arms"] == detail["arms"]
    assert client.patch(f"/api/experiments/{story}", json={"title": None}, headers=FETCH).status_code == 422
