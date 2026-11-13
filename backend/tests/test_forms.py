import math
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

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


def lot(client: TestClient, lot_number: str) -> dict:
    return next(r for r in client.get("/api/inventory/reagent-lots").json() if r["lot_number"] == lot_number)


def test_the_forms_get_their_choices_in_one_call(client: TestClient) -> None:
    reference = client.get("/api/reference").json()
    assert "tucatinib" in {c["name"] for c in reference["compounds"]}
    assert "CYP2C8" in {e["name"] for e in reference["enzymes"]}
    assert "KTZ-25088" in {r["lot_number"] for r in reference["reagent_lots"]}
    assert "HLM10-2606" in {t["lot_number"] for t in reference["tissue_lots"]}
    assert len(reference["study_types"]) == 8 and reference["pathway_roles"] == ["major", "minor", "unknown"]


def test_a_lot_of_a_new_reagent_can_be_added(client: TestClient) -> None:
    response = client.post(
        "/api/inventory/reagent-lots",
        json={
            "reagent_name": "Gemfibrozil 1-O-beta-glucuronide",
            "reagent_type": "inhibitor",
            "compound_name": "gemfibrozil glucuronide",
            "lot_number": "GEMG-2611",
            "concentration": 10,
            "concentration_unit": "mM",
            "expiry_date": "2027-11-30",
            "quantity_received": 1,
            "quantity_remaining": 1,
            "quantity_unit": "mL",
        },
        headers=FETCH,
    )
    assert response.status_code == 201
    assert response.json()["reagent"] == "Gemfibrozil 1-O-beta-glucuronide"
    assert lot(client, "GEMG-2611")["compound"] == "gemfibrozil glucuronide"


def test_an_unopened_lot_counts_as_full(client: TestClient) -> None:
    body = {"reagent_name": "quinidine", "lot_number": "QND-26001", "quantity_received": 2, "quantity_unit": "mL"}
    created = client.post("/api/inventory/reagent-lots", json=body, headers=FETCH).json()
    assert created["quantity_remaining"] == 2 and created["percent_remaining"] == pytest.approx(100)


def test_a_repeated_lot_number_is_explained(client: TestClient) -> None:
    body = {"reagent_name": "ketoconazole", "lot_number": "KTZ-25088"}
    response = client.post("/api/inventory/reagent-lots", json=body, headers=FETCH)
    assert response.status_code == 409
    assert response.json() == {"detail": "That lot number already exists for this reagent."}


def test_editing_a_lot_updates_its_flags(client: TestClient) -> None:
    ketoconazole = lot(client, "KTZ-25088")
    url = f"/api/inventory/reagent-lots/{ketoconazole['id']}"

    low = client.patch(url, json={"quantity_remaining": 0.1}, headers=FETCH).json()
    assert low["percent_remaining"] == pytest.approx(10) and "low_stock" in low["flags"]

    used_up = client.patch(url, json={"is_depleted": True}, headers=FETCH).json()
    assert "depleted" in used_up["flags"]

    cleared = client.patch(url, json={"expiry_date": None}, headers=FETCH).json()
    assert cleared["expiry_date"] is None and "expiring_soon" not in cleared["flags"]


def test_a_lot_cannot_hold_more_than_was_received(client: TestClient) -> None:
    url = f"/api/inventory/reagent-lots/{lot(client, 'KTZ-25088')['id']}"
    response = client.patch(url, json={"quantity_remaining": 5}, headers=FETCH)
    assert response.status_code == 409
    assert response.json()["detail"] == "The amount remaining can't be more than the amount received."
    assert client.patch(url, json={"lot_number": None}, headers=FETCH).status_code == 422


def test_a_new_experiment_can_be_planned_pasted_and_fitted(client: TestClient) -> None:
    hlm = next(t for t in client.get("/api/inventory/tissue-lots").json() if t["lot_number"] == "HLM10-2606")
    created = client.post(
        "/api/experiments",
        json={
            "title": "Bupropion phenotyping in pooled HLM",
            "study_type": "chemical_inhibition",
            "experiment_date": "2026-11-04",
            "substrate": "bupropion",
            "tissue_lot_id": hlm["id"],
            "condition": {"protein_concentration": 0.5, "incubation_time": 60, "preincubation_time": 5, "fu_inc": 0.8},
            "cofactors": [{"cofactor": "NADPH", "concentration": 1, "concentration_unit": "mM"}],
            "arms": [{"inhibitor": "ticlopidine", "target_enzyme": "CYP2B6", "concentration": 1}],
            "pathways": [{"enzyme": "CYP2B6", "pathway_role": "major"}],
        },
        headers=FETCH,
    )
    assert created.status_code == 201
    experiment = created.json()
    assert experiment["code"] == "WL-2026-052"
    assert experiment["status"] == "planned" and experiment["performed_by"] == "Wet Lab demo user"
    assert [(a["label"], a["kind"]) for a in experiment["arms"]] == [
        ("Vehicle control", "control"),
        ("ticlopidine", "inhibitor"),
    ]

    url = f"/api/experiments/{experiment['id']}"
    columns = client.get(f"{url}/measurements").json()["template_columns"]
    assert columns[0] == "Time (min)" and len(columns) == 7
    times = (0, 5, 15, 30, 45, 60)
    lines = ["\t".join(columns)] + [
        "\t".join([str(t)] + [f"{100 * math.exp(-0.03 * t):.2f}"] * 3 + [f"{100 * math.exp(-0.01 * t):.2f}"] * 3)
        for t in times
    ]
    preview = client.post(f"{url}/measurements/paste-preview", json={"text": "\n".join(lines)}, headers=FETCH).json()
    assert preview["errors"] == [] and len(preview["rows"]) == 36
    saved = client.put(
        f"{url}/measurements",
        json={"rows": preview["rows"], "substrate_concentration": 1, "substrate_concentration_unit": "uM"},
        headers=FETCH,
    )
    assert saved.status_code == 200

    result = client.get(f"{url}/depletion").json()
    control = next(a for a in result["arms"] if a["kind"] == "control")
    ticlopidine = next(a for a in result["arms"] if a["label"] == "ticlopidine")
    assert control["fit"]["clint_app"] == pytest.approx(60.0, rel=0.01)
    assert ticlopidine["inhibition"]["percent"] == pytest.approx(66.7, abs=0.5)
    assert client.get(url).json()["substrate_concentrations"] == [{"value": 1.0, "unit": "uM"}]


def test_a_preincubation_longer_than_the_incubation_is_refused(client: TestClient) -> None:
    response = client.post(
        "/api/experiments",
        json={
            "title": "Bad timing",
            "study_type": "substrate_depletion",
            "substrate": "midazolam",
            "condition": {"incubation_time": 5, "preincubation_time": 10},
        },
        headers=FETCH,
    )
    assert response.status_code == 422
    assert "preincubation can't be longer" in response.json()["detail"][0]["msg"]


def _plan_with_lot(client: TestClient, reagent_lot_id: int) -> dict:
    created = client.post(
        "/api/experiments",
        json={
            "title": "Tucatinib with ketoconazole",
            "study_type": "chemical_inhibition",
            "substrate": "tucatinib",
            "arms": [{"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1, "reagent_lot_id": reagent_lot_id}],
        },
        headers=FETCH,
    )
    assert created.status_code == 201
    return next(a for a in created.json()["arms"] if a["modulator_id"] is not None)


def test_two_lots_of_one_reagent_keep_their_own_catalog_numbers(client: TestClient) -> None:
    added = client.post(
        "/api/inventory/reagent-lots",
        json={"reagent_name": "Ketoconazole", "lot_number": "KTZ-26101", "vendor": "Vendor C", "catalog_number": "K-1003"},
        headers=FETCH,
    )
    assert added.status_code == 201
    edited = client.patch(
        f"/api/inventory/reagent-lots/{lot(client, 'KTZ-25088')['id']}",
        json={"vendor": "Vendor B", "catalog_number": "K-1001"},
        headers=FETCH,
    )
    assert edited.status_code == 200

    first = _plan_with_lot(client, lot(client, "KTZ-25088")["id"])
    second = _plan_with_lot(client, lot(client, "KTZ-26101")["id"])
    assert (first["lot"]["lot_number"], second["lot"]["lot_number"]) == ("KTZ-25088", "KTZ-26101")

    rows = {r["lot_number"]: r for r in client.get("/api/inventory/reagent-lots").json()}
    assert rows["KTZ-25088"]["reagent"] == rows["KTZ-26101"]["reagent"] == "Ketoconazole"
    assert (rows["KTZ-25088"]["vendor"], rows["KTZ-25088"]["catalog_number"]) == ("Vendor B", "K-1001")
    assert (rows["KTZ-26101"]["vendor"], rows["KTZ-26101"]["catalog_number"]) == ("Vendor C", "K-1003")


def test_editing_a_lots_vendor_leaves_its_catalog_number(client: TestClient) -> None:
    url = f"/api/inventory/reagent-lots/{lot(client, 'MTK-25092')['id']}"
    assert client.patch(url, json={"catalog_number": "M-2001"}, headers=FETCH).status_code == 200
    edited = client.patch(url, json={"vendor": "Vendor D"}, headers=FETCH).json()
    assert (edited["vendor"], edited["catalog_number"]) == ("Vendor D", "M-2001")


def test_a_lot_without_its_own_identity_shows_the_reagents(client: TestClient) -> None:
    created = client.post(
        "/api/inventory/reagent-lots",
        json={"reagent_name": "Furafylline", "reagent_type": "inhibitor", "lot_number": "FUR-1", "vendor": "Vendor E", "catalog_number": "F-77"},
        headers=FETCH,
    ).json()
    cleared = client.patch(
        f"/api/inventory/reagent-lots/{created['id']}", json={"vendor": None, "catalog_number": None}, headers=FETCH
    ).json()
    assert (cleared["vendor"], cleared["catalog_number"]) == ("Vendor E", "F-77")


HLM = {
    "material_type": "HLM",
    "pooled_or_individual": "pooled",
    "number_of_donors": 50,
    "vendor_or_source": "Corning",
    "lot_number": "HLM-T-001",
    "protein_concentration": 20,
    "quantity_remaining": 500,
    "quantity_unit": "uL",
}


def test_a_new_tissue_lot_is_listed_and_offered_to_new_experiments(client: TestClient) -> None:
    response = client.post("/api/inventory/tissue-lots", json=HLM, headers=FETCH)
    assert response.status_code == 201
    created = response.json()
    assert created["species"] == "human" and created["protein_concentration_unit"] == "mg/mL"
    assert created["number_of_donors"] == 50 and created["flags"] == []

    listed = client.get("/api/inventory/tissue-lots").json()
    assert created in listed
    offered = client.get("/api/reference").json()["tissue_lots"]
    assert "HLM-T-001" in {t["lot_number"] for t in offered}
    detail = client.get(f"/api/inventory/tissue-lots/{created['id']}").json()
    assert detail["lot_number"] == "HLM-T-001"


def test_a_tissue_lot_records_its_organ_and_fraction(client: TestClient, engine: Engine) -> None:
    body = {"material_type": "intestinal_microsomes", "lot_number": "IM-T-001"}
    lot_id = client.post("/api/inventory/tissue-lots", json=body, headers=FETCH).json()["id"]
    with engine.connect() as connection:
        row = connection.execute(
            text("select organ_or_tissue, tissue_fraction from lab.tissue_lot where id = :id"), {"id": lot_id}
        ).one()
    assert tuple(row) == ("intestine", "microsome")


def test_a_repeated_tissue_lot_number_is_explained(client: TestClient) -> None:
    assert client.post("/api/inventory/tissue-lots", json=HLM, headers=FETCH).status_code == 201
    response = client.post("/api/inventory/tissue-lots", json=HLM, headers=FETCH)
    assert response.status_code == 409
    assert response.json() == {"detail": "That lot number already exists for this supplier."}


@pytest.mark.parametrize(
    "change",
    [
        {"viability": 90},
        {"material_type": "plasma"},
        {"number_of_donors": 0},
        {"pooled_or_individual": "individual", "number_of_donors": 5},
        {"lot_number": ""},
    ],
)
def test_a_tissue_lot_that_breaks_the_rules_is_refused(client: TestClient, change: dict) -> None:
    response = client.post("/api/inventory/tissue-lots", json={**HLM, **change}, headers=FETCH)
    assert response.status_code == 422


def test_hepatocytes_may_carry_a_viability(client: TestClient) -> None:
    body = {"material_type": "hepatocytes", "lot_number": "HEP-T-001", "viability": 87.5}
    assert client.post("/api/inventory/tissue-lots", json=body, headers=FETCH).json()["viability"] == 87.5


def test_tissue_catalog_and_notes_survive_every_read_path(client: TestClient) -> None:
    body = HLM | {"catalog_number": "HLM-CAT-42", "notes": "Do not refreeze after thawing."}
    created = client.post("/api/inventory/tissue-lots", json=body, headers=FETCH).json()
    for row in (
        created,
        client.get(f"/api/inventory/tissue-lots/{created['id']}").json(),
        next(r for r in client.get("/api/inventory/tissue-lots").json() if r["id"] == created["id"]),
        next(r for r in client.get("/api/reference").json()["tissue_lots"] if r["id"] == created["id"]),
    ):
        assert row["catalog_number"] == body["catalog_number"]
        assert row["notes"] == body["notes"]


def test_tissue_stock_can_be_updated_used_up_and_restocked(client: TestClient) -> None:
    created = client.post("/api/inventory/tissue-lots", json=HLM, headers=FETCH).json()
    url = f"/api/inventory/tissue-lots/{created['id']}"
    changed = client.patch(url, json={"quantity_remaining": 100, "notes": "One vial remains."}, headers=FETCH)
    assert changed.status_code == 200
    assert changed.json()["quantity_remaining"] == 100
    assert changed.json()["quantity_unit"] == "uL"
    assert changed.json()["lot_number"] == HLM["lot_number"]
    assert client.get(url).json()["notes"] == "One vial remains."
    used_up = client.patch(url, json={"is_depleted": True}, headers=FETCH).json()
    assert "depleted" in used_up["flags"]
    empty = client.patch(url, json={"quantity_remaining": 0, "is_depleted": False}, headers=FETCH).json()
    assert "depleted" in empty["flags"]
    alerts = client.get("/api/dashboard").json()["lot_alerts"]
    assert any(alert["kind"] == "tissue" and alert["id"] == created["id"] for alert in alerts)
    refilled = client.patch(url, json={"quantity_remaining": 500}, headers=FETCH).json()
    assert refilled["flags"] == []
    assert client.patch(url, json={"is_depleted": None}, headers=FETCH).status_code == 422
    assert client.patch(url, json={"quantity_remaining": -1}, headers=FETCH).status_code == 422
    assert client.patch("/api/inventory/tissue-lots/99999999", json={"quantity_remaining": 1}, headers=FETCH).status_code == 404


def test_a_new_zero_quantity_tissue_lot_is_depleted(client: TestClient) -> None:
    created = client.post("/api/inventory/tissue-lots", json=HLM | {"quantity_remaining": 0}, headers=FETCH).json()
    assert "depleted" in created["flags"]


def test_zero_stock_does_not_set_the_reagents_manual_depleted_flag(client: TestClient) -> None:
    row = lot(client, "KTZ-25088")
    url = f"/api/inventory/reagent-lots/{row['id']}"
    empty = client.patch(url, json={"quantity_remaining": 0}, headers=FETCH).json()
    assert empty["is_depleted"] is False
    assert "depleted" in empty["flags"]
    replenished = client.patch(url, json={"quantity_remaining": row["quantity_remaining"]}, headers=FETCH).json()
    assert replenished["is_depleted"] is False
    assert "depleted" not in replenished["flags"]
