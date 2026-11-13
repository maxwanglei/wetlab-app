"""Raw data for a single-endpoint experiment: one read per well at the end of the last stage, for the parent and for
each metabolite, pasted one row per condition."""

import csv
import io
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.db import get_engine
from app.main import app
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}
NADPH = {"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM"}
ENDPOINT = {
    "title": "Tucatinib, single endpoint",
    "study_type": "chemical_inhibition",
    "substrate": "tucatinib",
    "sampling": "endpoint",
    "stages": [
        {"stage_type": "primary", "incubation_minutes": 5, "protein_concentration": 0.5},
        {"stage_type": "secondary", "incubation_minutes": 10, "protein_concentration": 0.05, "dilution_factor": 10, "diluted_from": "primary"},
    ],
    "cofactors": [NADPH],
    "controls": [
        {"stage": "primary", "control_type": "vehicle", "label": "Vehicle", "incubation_minutes": 30},
        {"stage": "primary", "control_type": "minus_cofactor", "label": "Minus NADPH", "omitted_cofactor": 0, "incubation_minutes": 30, "replicates": 1},
        {"stage": "secondary", "control_type": "vehicle", "label": "Vehicle"},
    ],
    "arms": [
        {"inhibitor": "gemfibrozil glucuronide", "concentration": 64, "incubation_minutes": 30},
        {"inhibitor": "gemfibrozil glucuronide", "concentration": 64, "incubation_minutes": 30, "cofactor_omitted": True, "omitted_cofactor": 0, "replicates": 1},
        {"inhibitor": "ketoconazole", "concentration": 1, "stage": "secondary"},
    ],
}
LABELS = [
    "Vehicle (primary)",
    "gemfibrozil glucuronide (primary)",
    "gemfibrozil glucuronide minus NADPH (primary)",
    "Minus NADPH (primary)",
    "Vehicle (secondary)",
    "ketoconazole (secondary)",
]
PARENT = {
    "Vehicle (primary)": ["0.61", "0.63", "0.60"],
    "gemfibrozil glucuronide (primary)": ["0.9", "0.92", "0.91"],
    "gemfibrozil glucuronide minus NADPH (primary)": ["0.98"],
    "Minus NADPH (primary)": ["0.99"],
    "Vehicle (secondary)": ["0.55", "0.56", "0.57"],
    "ketoconazole (secondary)": ["0.8", "0.81", "0.79"],
}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def create(client: TestClient, design: dict) -> dict:
    created = client.post("/api/experiments", json=design, headers=FETCH)
    assert created.status_code == 201, created.text
    return created.json()


def block(values: dict[str, list[str]]) -> str:
    return "\n".join(["Condition\tR1\tR2\tR3", *("\t".join([label, *values[label]]) for label in LABELS)])


def preview(client: TestClient, experiment: dict, text: str, metabolite: str | None = None):
    body = {"text": text, "value_kind": "area_ratio"} | ({"metabolite": metabolite} if metabolite else {})
    return client.post(f"/api/experiments/{experiment['id']}/measurements/paste-preview", json=body, headers=FETCH)


def save(client: TestClient, experiment: dict, values: dict[str, list[str]], metabolite: str | None = None) -> dict:
    parsed = preview(client, experiment, block(values), metabolite)
    assert parsed.status_code == 200 and parsed.json()["errors"] == [], parsed.text
    body = {"rows": parsed.json()["rows"], "value_kind": "area_ratio", "substrate_concentration": 1} | (
        {"metabolite": metabolite} if metabolite else {}
    )
    saved = client.put(f"/api/experiments/{experiment['id']}/measurements", json=body, headers=FETCH)
    assert saved.status_code == 200, saved.text
    return saved.json()


def values(listing: dict) -> dict[str, list[float]]:
    label = {arm["key"]: arm["label"] for arm in listing["arms"]}
    out: dict[str, list[float]] = {}
    for row in sorted(listing["rows"], key=lambda row: row["replicate"]):
        out.setdefault(label[row["arm_key"]], []).append(row["raw_value"])
    return out


def test_the_template_is_one_row_per_condition_with_its_planned_replicates(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    listing = client.get(f"/api/experiments/{experiment['id']}/measurements").json()
    assert listing["template_columns"] == ["Condition", "R1", "R2", "R3"]
    assert [(arm["label"], arm["replicates"]) for arm in listing["arms"]] == list(zip(LABELS, [3, 3, 1, 1, 3, 3], strict=True))
    assert listing["analytes"] == [] and listing["rows"] == []


def test_the_parent_then_a_metabolite_each_replace_only_their_own_rows(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    url = f"/api/experiments/{experiment['id']}/measurements"
    parent = save(client, experiment, PARENT)
    assert values(parent)["gemfibrozil glucuronide minus NADPH (primary)"] == [0.98]
    assert {(row["timepoint"], row["percent_of_t0"], row["raw_unit"]) for row in parent["rows"]} == {(10, None, "area_ratio")}

    formed = {label: ["0"] * len(cells) for label, cells in PARENT.items()} | {"Vehicle (primary)": ["0.12", "0.11", "0.13"]}
    metabolite = save(client, experiment, formed, metabolite="hydroxy-tucatinib")
    assert values(metabolite)["Vehicle (primary)"] == [0.12, 0.11, 0.13]
    assert metabolite["analytes"] == [
        {"name": "tucatinib", "metabolite": None},
        {"name": "hydroxy-tucatinib", "metabolite": "hydroxy-tucatinib"},
    ]
    assert values(client.get(url).json()) == {label: [float(v) for v in cells] for label, cells in PARENT.items()}

    again = save(client, experiment, formed | {"Vehicle (primary)": ["0.2", "0.2", "0.2"]}, metabolite="Hydroxy-Tucatinib")
    assert values(again)["Vehicle (primary)"] == [0.2, 0.2, 0.2] and len(again["rows"]) == 14
    assert len(client.get(url).json()["rows"]) == 14
    assert len(client.get(url, params={"metabolite": "hydroxy-tucatinib"}).json()["rows"]) == 14
    assert client.get(url, params={"metabolite": "N-oxide"}).json()["rows"] == []
    assert client.get(f"/api/experiments/{experiment['id']}").json()["has_bench_data"] is True


def test_a_row_whose_label_is_not_the_template_s_is_named(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    text = block(PARENT).replace("Minus NADPH (primary)", "Minus NADPH (secondary)")
    assert preview(client, experiment, text).json()["errors"] == [
        "Row 5: 'Minus NADPH (secondary)' is not Minus NADPH (primary). Paste the rows in the template's order."
    ]
    lower = block(PARENT).replace("Vehicle (primary)", "  vehicle (PRIMARY) ")
    assert preview(client, experiment, lower).json()["errors"] == []


def test_more_values_than_a_condition_plans_are_refused(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    errors = preview(client, experiment, block(PARENT | {"Minus NADPH (primary)": ["0.99", "0.98"]})).json()["errors"]
    assert errors == ["Row 5, Minus NADPH (primary) R2: this condition plans 1 replicate."]


def test_a_metabolite_may_read_zero_and_the_parent_may_not(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    zero = PARENT | {"Vehicle (primary)": ["0", "0.63", "0.60"]}
    assert preview(client, experiment, block(zero), "hydroxy-tucatinib").json()["errors"] == []
    assert preview(client, experiment, block(zero)).json()["errors"] == ["Row 2, Vehicle (primary) R1: values must be positive."]
    rows = preview(client, experiment, block(zero), "hydroxy-tucatinib").json()["rows"]
    url = f"/api/experiments/{experiment['id']}/measurements"
    refused = client.put(url, json={"rows": rows, "value_kind": "area_ratio"}, headers=FETCH)
    assert refused.status_code == 422 and "must be more than 0" in refused.json()["detail"]


def test_an_endpoint_takes_area_ratios_and_a_time_course_takes_no_metabolite(client: TestClient) -> None:
    experiment = create(client, ENDPOINT)
    url = f"/api/experiments/{experiment['id']}/measurements/paste-preview"
    assert client.post(url, json={"text": block(PARENT)}, headers=FETCH).status_code == 422

    time_course = create(client, ENDPOINT | {"sampling": "time_course"})
    url = f"/api/experiments/{time_course['id']}/measurements"
    assert preview(client, time_course, "0\t100", "hydroxy-tucatinib").status_code == 422
    assert client.get(url, params={"metabolite": "hydroxy-tucatinib"}).status_code == 422
    row = {"arm_key": time_course["arms"][0]["key"], "replicate": 1, "timepoint": 0, "percent_of_t0": 100}
    assert client.put(url, json={"rows": [row], "metabolite": "hydroxy-tucatinib"}, headers=FETCH).status_code == 422


def test_a_metabolite_includes_the_minus_substrate_blank_in_preview_save_and_export(client: TestClient) -> None:
    experiment = create(client, {
        "title": "Metabolite blank", "study_type": "metabolite_formation", "substrate": "tucatinib",
        "sampling": "endpoint", "stages": [{"stage_type": "primary", "incubation_minutes": 10}],
        "controls": [
            {"control_type": "complete", "label": "Complete", "replicates": 1},
            {"control_type": "minus_substrate", "label": "No substrate", "replicates": 1},
        ],
    })
    url = f"/api/experiments/{experiment['id']}"
    assert [arm["label"] for arm in client.get(f"{url}/measurements").json()["arms"]] == ["Complete"]
    metabolite = "hydroxy-tucatinib"
    shown = client.get(f"{url}/measurements", params={"metabolite": metabolite}).json()
    assert [arm["label"] for arm in shown["arms"]] == ["Complete", "No substrate"]
    parsed = preview(client, experiment, "Condition\tR1\nComplete\t0.12\nNo substrate\t0", metabolite)
    assert parsed.status_code == 200 and parsed.json()["errors"] == []
    saved = client.put(f"{url}/measurements", json={
        "metabolite": metabolite, "value_kind": "area_ratio", "rows": parsed.json()["rows"],
    }, headers=FETCH)
    assert saved.status_code == 200, saved.text
    reloaded = client.get(f"{url}/measurements", params={"metabolite": metabolite}).json()
    assert values(reloaded) == {"Complete": [0.12], "No substrate": [0]}
    exported = list(csv.DictReader(io.StringIO(client.get(f"{url}/export.csv").content.decode("utf-8-sig"))))
    blank = next(row for row in exported if row["control_type"] == "minus_substrate")
    assert (blank["analyte"], blank["raw_value"]) == (metabolite, "0")


def test_the_csv_names_each_row_s_analyte_and_its_condition_s_time(client: TestClient) -> None:
    lot = next(lot["id"] for lot in client.get("/api/reference").json()["reagent_lots"] if lot["lot_number"] == "NAD-25610")
    experiment = create(client, ENDPOINT | {"cofactors": [NADPH | {"reagent_lot_id": lot}]})
    save(client, experiment, PARENT)
    save(client, experiment, {label: ["0.05"] * len(cells) for label, cells in PARENT.items()}, metabolite="hydroxy-tucatinib")
    body = client.get(f"/api/experiments/{experiment['id']}/export.csv").content
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"), newline="")))
    assert len(rows) == 28
    assert [row["analyte"] for row in rows] == ["tucatinib"] * 14 + ["hydroxy-tucatinib"] * 14
    minutes = {(row["series_label"], row["condition_minutes"]) for row in rows}
    assert minutes == {
        ("Vehicle (primary)", "30"),
        ("gemfibrozil glucuronide (primary)", "30"),
        ("gemfibrozil glucuronide minus NADPH (primary)", "30"),
        ("Minus NADPH (primary)", "30"),
        ("Vehicle (secondary)", "10"),
        ("ketoconazole (secondary)", "10"),
    }
    assert {(row["time"], row["stage_sampled"], row["raw_unit"], row["percent_of_t0"]) for row in rows} == {("10", "secondary", "area_ratio", "")}
    lots = {(row["series_label"], row["cofactor_lot_numbers"]) for row in rows if row["series_label"].startswith(("Minus", "Vehicle"))}
    assert lots == {("Minus NADPH (primary)", ""), ("Vehicle (primary)", "NAD-25610"), ("Vehicle (secondary)", "NAD-25610")}
