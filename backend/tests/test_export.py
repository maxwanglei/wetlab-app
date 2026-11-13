import csv
import io
import math
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import app
from app.models import AssayMeasurement
from app.seed.demo import reset
from app.services.export import COLUMNS
from tests.test_controls import SOLVENT_PANEL
from tests.test_internal_standard import GEMFIBROZIL, RATES as GEMFIBROZIL_RATES

FETCH = {"X-Requested-With": "wetlab"}
TIMES = (0, 5, 15, 30, 45, 60)
STANDARD_COLUMNS = {column for column in COLUMNS if column.startswith("internal_standard")}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def download(client: TestClient, experiment_id: int) -> tuple[list[dict[str, str]], bytes, dict]:
    response = client.get(f"/api/experiments/{experiment_id}/export.csv")
    assert response.status_code == 200, response.text
    body = response.content
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"), newline="")))
    return rows, body, dict(response.headers)


def paste(client: TestClient, experiment: dict, rates: dict[str, float]) -> None:
    url = f"/api/experiments/{experiment['id']}"
    rows = [
        {"arm_key": arm["key"], "replicate": r, "timepoint": t, "percent_of_t0": 100 * math.exp(-rates[arm["label"]] * t)}
        for arm in client.get(f"{url}/measurements").json()["arms"]
        for r in (1, 2, 3)
        for t in TIMES
    ]
    assert client.put(f"{url}/measurements", json={"rows": rows, "substrate_concentration": 1}, headers=FETCH).status_code == 200


def reference(client: TestClient) -> dict:
    return client.get("/api/reference").json()


def test_the_file_opens_in_excel_as_utf8_with_one_row_per_measurement(client: TestClient, engine: Engine) -> None:
    experiment = next(e for e in client.get("/api/experiments").json() if e["code"] == "WL-2026-047")
    rows, body, headers = download(client, experiment["id"])
    assert headers["content-type"] == "text/csv; charset=utf-8"
    assert headers["content-disposition"] == 'attachment; filename="WL-2026-047-measurements.csv"'
    assert body.startswith(b"\xef\xbb\xbf")
    assert body.count(b"\r\n") == len(rows) + 1 and b"\n" not in body.replace(b"\r\n", b"")
    assert body.decode("utf-8-sig").isascii()
    assert list(rows[0]) == COLUMNS and COLUMNS[-2:] == ["analyte", "condition_minutes"]
    with Session(engine) as session:
        stored = {
            m.id: m for m in session.scalars(select(AssayMeasurement).where(AssayMeasurement.experiment_id == experiment["id"]))
        }
    assert len(rows) == len(stored) == 72
    for row in rows:
        measurement = stored[int(row["measurement_id"])]
        assert float(row["percent_of_t0"]) == float(measurement.normalized_value)
        assert int(row["replicate"]) == measurement.replicate_number and float(row["time"]) == float(measurement.timepoint)
        assert row["excluded"] in ("TRUE", "FALSE")
    vehicle = [row for row in rows if row["series_label"] == "Vehicle control"]
    assert len(vehicle) == 18 and {row["kind"] for row in vehicle} == {"control"}
    assert {row["reference_label"] for row in rows if row["kind"] != "control"} == {"Vehicle control"}
    assert {row["tissue_lot_number"] for row in rows} == {"HLM10-2606"}


def test_the_gemfibrozil_export_keeps_the_internal_standard_in_its_own_columns(client: TestClient) -> None:
    lots = {lot["lot_number"]: lot["id"] for lot in reference(client)["reagent_lots"]}
    design = GEMFIBROZIL | {
        "cofactors": [GEMFIBROZIL["cofactors"][0] | {"reagent_lot_id": lots["NAD-25610"]}],
    }
    experiment = client.post("/api/experiments", json=design, headers=FETCH).json()
    paste(client, experiment, GEMFIBROZIL_RATES)
    rows, _, _ = download(client, experiment["id"])
    assert len(rows) == len(GEMFIBROZIL_RATES) * 3 * len(TIMES)
    for row in rows:
        assert (row["internal_standard"], row["internal_standard_concentration"], row["internal_standard_unit"]) == ("D3-imatinib", "50", "nM")
        assert (row["internal_standard_addition_step"], row["internal_standard_solvent"]) == ("reaction_termination", "ice-cold acetonitrile")
        assert not any("imatinib" in value.lower() for column, value in row.items() if column not in STANDARD_COLUMNS)
        assert (row["stage_sampled"], float(row["sampled_protein"])) == ("secondary", 0.05)
    by_label = {}
    for row in rows:
        by_label.setdefault(row["series_label"], row)
    assert by_label["gemfibrozil glucuronide 100 uM (primary)"]["stage_entered"] == "primary"
    assert by_label["gemfibrozil glucuronide 100 uM (primary)"]["reference_label"] == "Vehicle control (primary)"
    assert by_label["gemfibrozil glucuronide 100 uM (primary)"]["compound"] == "gemfibrozil glucuronide"
    assert by_label["ketoconazole (secondary)"]["reference_label"] == "Vehicle control (secondary)"
    # NADPH goes back in when the primary minus-NADPH incubation is diluted into the secondary stage.
    assert by_label["Minus NADPH (primary)"]["cofactor_lot_numbers"] == "NAD-25610"
    assert by_label["Minus NADPH (secondary)"]["cofactor_lot_numbers"] == ""
    assert by_label["Vehicle control (secondary)"]["cofactor_lot_numbers"] == "NAD-25610"


def test_each_row_names_its_control_and_reference_and_a_minus_protein_row_has_no_tissue_lot(client: TestClient) -> None:
    tissue = next(lot["id"] for lot in reference(client)["tissue_lots"] if lot["lot_number"] == "HLM10-2606")
    design = SOLVENT_PANEL | {
        "title": "Export panel",
        "study_type": "chemical_inhibition",
        "substrate": "amodiaquine",
        "tissue_lot_id": tissue,
        "controls": [*SOLVENT_PANEL["controls"], {"control_type": "minus_protein"}],
    }
    experiment = client.post("/api/experiments", json=design, headers=FETCH).json()
    rates = {arm["label"]: 0.01 for arm in experiment["arms"]}
    paste(client, experiment, rates)
    rows, _, _ = download(client, experiment["id"])
    first = {}
    for row in rows:
        first.setdefault(row["series_label"], row)
    assert first["ketoconazole"]["solvent"] == "DMSO" and first["ketoconazole"]["reference_label"] == "Vehicle control (DMSO 0.1%)"
    assert first["montelukast"]["solvent"] == "acetonitrile"
    assert first["montelukast"]["reference_label"] == "Vehicle control (acetonitrile 0.5%)"
    assert first["quinidine"]["reference_label"] == "" and first["quinidine"]["reference_control_id"] == ""
    minus_udpga = first["Minus UDPGA"]
    assert (minus_udpga["control_type"], minus_udpga["omitted_cofactor"], minus_udpga["control_label"]) == (
        "minus_cofactor",
        "UDPGA",
        "Minus UDPGA",
    )
    assert first["Vehicle control (DMSO 0.1%)"]["control_id"] != ""
    for row in rows:
        expected_tissue = "" if row["control_type"] == "minus_protein" else "HLM10-2606"
        assert row["tissue_lot_number"] == expected_tissue
    assert any(row["control_type"] == "minus_protein" for row in rows)


def test_an_experiment_without_measurements_exports_only_its_header(client: TestClient) -> None:
    created = client.post(
        "/api/experiments", json={"title": "Empty", "study_type": "substrate_depletion", "substrate": "midazolam"}, headers=FETCH
    ).json()
    rows, body, headers = download(client, created["id"])
    assert rows == [] and body.decode("utf-8-sig") == ",".join(COLUMNS) + "\r\n"
    assert client.get("/api/experiments/999999/export.csv").status_code == 404


def test_every_column_carries_what_the_app_holds(client: TestClient) -> None:
    data = reference(client)
    lots = {lot["lot_number"]: lot["id"] for lot in data["reagent_lots"]}
    tissue = next(lot["id"] for lot in data["tissue_lots"] if lot["lot_number"] == "HLM10-2606")
    nadph = {"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM", "reagent_lot_id": lots["NAD-25610"]}
    design = {
        "code": '=HYPERLINK("x")',
        "title": "Every column",
        "study_type": "chemical_inhibition",
        "substrate": "tucatinib",
        "substrate_reagent_lot_id": lots["TUC-26014"],
        "tissue_lot_id": tissue,
        "stages": [{"stage_type": "primary", "incubation_minutes": 60, "protein_concentration": 0.5}],
        "condition": {"solvent": "DMSO", "solvent_percentage": 0.1},
        "cofactors": [nadph],
        "controls": [
            {"control_type": "vehicle"},
            {"control_type": "minus_cofactor", "omitted_cofactor": 0},
            {"control_type": "heat_inactivated", "protein_concentration": 0.2},
            {"control_type": "minus_protein"},
        ],
        "arms": [
            {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1, "reagent_lot_id": lots["KTZ-25088"]},
            {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1, "cofactor_omitted": True, "omitted_cofactor": 0},
        ],
        "internal_standard": {"compound": "tucatinib-d6", "concentration": 50, "concentration_unit": "nM", "reagent_lot_id": lots["TUCD6-2602"]},
        "pathways": [{"enzyme": "CYP3A4", "pathway_role": "major"}],
    }
    created = client.post("/api/experiments", json=design, headers=FETCH)
    assert created.status_code == 201, created.text
    experiment = created.json()
    paste(client, experiment, {arm["label"]: 0.01 for arm in experiment["arms"]})
    url = f"/api/experiments/{experiment['id']}"
    first_point = client.get(f"{url}/measurements").json()["rows"][0]["id"]
    assert client.post(f"{url}/depletion/save", json={"exclusions": [{"measurement_id": first_point, "reason": "carryover"}]}, headers=FETCH).status_code == 200

    rows, _, headers = download(client, experiment["id"])
    assert headers["content-disposition"] == 'attachment; filename="-HYPERLINK--x---measurements.csv"'
    by_label: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_label.setdefault(row["series_label"], []).append(row)
    for row in rows:
        assert row["experiment_code"] == '\'=HYPERLINK("x")'
        assert (row["substrate"], row["substrate_lot_number"], row["substrate_concentration"]) == ("tucatinib", "TUC-26014", "1")
        assert (row["internal_standard"], row["internal_standard_lot_number"], row["internal_standard_unit"]) == ("tucatinib-d6", "TUCD6-2602", "nM")
        assert (row["stage_entered"], row["stage_sampled"], row["time_unit"]) == ("primary", "primary", "min")
        assert (row["analyte"], row["condition_minutes"]) == ("tucatinib", "60")
        assert row["percent_of_t0"] == row["normalized_value"] and row["normalized_unit"] == "% of T0"

    arm = by_label["ketoconazole"][0]
    assert (arm["compound"], arm["concentration"], arm["concentration_unit"], arm["kind"]) == ("ketoconazole", "1", "uM", "inhibitor")
    assert (arm["inhibitor_lot_number"], arm["cofactor_omitted"], arm["cofactor_lot_numbers"]) == ("KTZ-25088", "FALSE", "NAD-25610")
    assert (arm["solvent"], arm["solvent_percentage"], arm["reference_label"]) == ("DMSO", "0.1", "Vehicle control")
    assert (arm["sampled_protein"], arm["tissue_lot_number"]) == ("0.5", "HLM10-2606")

    twin = by_label["ketoconazole minus NADPH"][0]
    assert (twin["cofactor_omitted"], twin["omitted_cofactor"], twin["cofactor_lot_numbers"]) == ("TRUE", "NADPH", "")
    minus_nadph = by_label["Minus NADPH"][0]
    assert (minus_nadph["control_type"], minus_nadph["cofactor_omitted"], minus_nadph["cofactor_lot_numbers"]) == ("minus_cofactor", "TRUE", "")
    assert by_label["Vehicle control"][0]["cofactor_lot_numbers"] == "NAD-25610"

    killed = by_label["Heat-inactivated 0.2 mg/mL"][0]
    assert (killed["protein_override"], killed["protein_override_unit"], killed["tissue_lot_number"]) == ("0.2", "mg/mL", "HLM10-2606")
    no_enzyme = by_label["Minus protein"][0]
    assert (no_enzyme["tissue_lot_id"], no_enzyme["sampled_protein"], no_enzyme["control_label"]) == ("", "", "Minus protein")

    excluded = next(row for row in rows if row["measurement_id"] == str(first_point))
    assert (excluded["excluded"], excluded["exclusion_reason"]) == ("TRUE", "carryover")
    assert sum(row["excluded"] == "TRUE" for row in rows) == 1


def test_a_code_outside_latin_1_still_downloads(client: TestClient) -> None:
    created = client.post(
        "/api/experiments", json={"code": "WL-Ω-1", "title": "Omega", "study_type": "substrate_depletion", "substrate": "midazolam"}, headers=FETCH
    ).json()
    _, _, headers = download(client, created["id"])
    assert headers["content-disposition"] == 'attachment; filename="WL---1-measurements.csv"'
