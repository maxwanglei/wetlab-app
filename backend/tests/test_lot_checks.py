from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.db import get_engine
from app.main import app
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def lots(client: TestClient) -> dict[str, int]:
    return {lot["lot_number"]: lot["id"] for lot in client.get("/api/reference").json()["reagent_lots"]}


def create(client: TestClient, **fields):
    body = {"title": "Lot check", "study_type": "chemical_inhibition", "substrate": "tucatinib"} | fields
    return client.post("/api/experiments", json=body, headers=FETCH)


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        (
            lambda lot: {"arms": [{"inhibitor": "ketoconazole", "concentration": 1, "reagent_lot_id": lot["MTK-25092"]}]},
            "ketoconazole arm: lot MTK-25092 is Montelukast sodium, a lot of montelukast, not ketoconazole.",
        ),
        (
            lambda lot: {"substrate_reagent_lot_id": lot["KTZ-25088"]},
            "Substrate: lot KTZ-25088 is Ketoconazole, a lot of ketoconazole, not tucatinib.",
        ),
        (
            lambda lot: {"internal_standard": {"compound": "D3-imatinib", "reagent_lot_id": lot["TUCD6-2602"]}},
            "Internal standard: lot TUCD6-2602 is Tucatinib-d6, a lot of tucatinib-d6, not D3-imatinib.",
        ),
    ],
)
def test_a_lot_of_another_compound_is_refused(client: TestClient, fields, message: str) -> None:
    refused = create(client, **fields(lots(client)))
    assert refused.status_code == 422
    assert refused.json()["detail"] == message


def test_a_lot_whose_reagent_names_no_compound_saves_with_a_warning(client: TestClient) -> None:
    lot = lots(client)
    created = create(client, arms=[{"inhibitor": "ketoconazole", "concentration": c, "reagent_lot_id": lot["DMSO-2601"]} for c in (1, 10)])
    assert created.status_code == 201
    assert created.json()["warnings"] == [
        "ketoconazole arm: lot DMSO-2601 (DMSO, anhydrous) names no compound, so it was not checked against ketoconazole."
    ]


def test_matching_lots_save_without_a_warning(client: TestClient) -> None:
    lot = lots(client)
    created = create(
        client,
        substrate_reagent_lot_id=lot["TUC-26014"],
        arms=[{"inhibitor": "Ketoconazole", "concentration": 1, "reagent_lot_id": lot["KTZ-25088"]}],
        internal_standard={"compound": "tucatinib-d6", "reagent_lot_id": lot["TUCD6-2602"]},
    )
    assert created.status_code == 201, created.text
    assert created.json()["warnings"] == []


def test_the_sample_experiments_lots_all_match(client: TestClient) -> None:
    for experiment in client.get("/api/experiments").json():
        assert client.get(f"/api/experiments/{experiment['id']}").json()["warnings"] == [], experiment["code"]


def test_a_lot_listed_under_its_reagents_name_is_accepted(client: TestClient) -> None:
    lot = lots(client)
    created = create(client, arms=[{"inhibitor": "Montelukast sodium", "concentration": 1, "reagent_lot_id": lot["MTK-25092"]}])
    assert created.status_code == 201, created.text
    assert created.json()["warnings"] == []


def test_a_stored_lot_of_another_compound_is_reported_on_every_read(client: TestClient, engine: Engine) -> None:
    from sqlalchemy import update
    from sqlalchemy.orm import Session

    from app.models import ExperimentModulator

    lot = lots(client)
    created = create(client, arms=[{"inhibitor": "ketoconazole", "concentration": 1, "reagent_lot_id": lot["KTZ-25088"]}]).json()
    with Session(engine) as session:
        session.execute(update(ExperimentModulator).where(ExperimentModulator.experiment_id == created["id"]).values(reagent_lot_id=lot["MTK-25092"]))
        session.commit()
    detail = client.get(f"/api/experiments/{created['id']}").json()
    assert detail["warnings"] == ["ketoconazole arm: lot MTK-25092 is Montelukast sodium, a lot of montelukast, not ketoconazole."]


def test_linking_a_reagent_to_its_compound_clears_the_note(client: TestClient) -> None:
    added = client.post(
        "/api/inventory/reagent-lots", json={"reagent_name": "KTZ hydrochloride, vendor C", "reagent_type": "inhibitor", "lot_number": "KC-1"}, headers=FETCH
    ).json()
    created = create(client, arms=[{"inhibitor": "ketoconazole", "concentration": 1, "reagent_lot_id": added["id"]}]).json()
    assert created["warnings"] == [
        "ketoconazole arm: lot KC-1 (KTZ hydrochloride, vendor C) names no compound, so it was not checked against ketoconazole."
    ]
    linked = client.patch(f"/api/inventory/reagent-lots/{added['id']}", json={"compound_name": "ketoconazole"}, headers=FETCH)
    assert linked.status_code == 200 and linked.json()["compound"] == "ketoconazole"
    assert client.get(f"/api/experiments/{created['id']}").json()["warnings"] == []
    again = client.patch(f"/api/inventory/reagent-lots/{added['id']}", json={"compound_name": "midazolam"}, headers=FETCH)
    assert again.status_code == 409 and again.json()["detail"] == "KTZ hydrochloride, vendor C is already linked to a compound."
