import math
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import CONSTRAINT_MESSAGES, app
from app.models import Experiment, ExperimentInternalStandard
from app.seed.demo import reset
from app.services import lookups

FETCH = {"X-Requested-With": "wetlab"}
TIMES = (0, 2, 4, 6, 8, 10)
PRIMARY = {"stage_type": "primary", "incubation_minutes": 30, "protein_concentration": 0.5}
SECONDARY = {
    "stage_type": "secondary",
    "incubation_minutes": 10,
    "protein_concentration": 0.05,
    "dilution_factor": 10,
    "diluted_from": "primary",
}
D3_IMATINIB = {"compound": "D3-imatinib", "concentration": 50, "concentration_unit": "nM"}

# The brief's first fixture: two stages, a tenfold dilution from 0.5 to 0.05 mg/mL, three inhibitors across both
# stages, a vehicle and a no-cofactor control in each stage, and D3-imatinib as the internal standard.
GEMFIBROZIL = {
    "title": "Gemfibrozil glucuronide inactivation of CYP2C8, read out after a tenfold dilution",
    "study_type": "chemical_inhibition",
    "substrate": "amodiaquine",
    "stages": [PRIMARY, SECONDARY],
    "condition": {"solvent": "DMSO", "solvent_percentage": 0.1},
    "cofactors": [{"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM"}],
    "controls": [
        {"stage": "primary", "control_type": "vehicle"},
        {"stage": "primary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
        {"stage": "secondary", "control_type": "vehicle"},
        {"stage": "secondary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
    ],
    "arms": [
        *({"inhibitor": "gemfibrozil glucuronide", "target_enzyme": "CYP2C8", "concentration": c} for c in (10, 30, 100)),
        {"inhibitor": "clopidogrel acyl glucuronide", "target_enzyme": "CYP2C8", "concentration": 10},
        {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1, "stage": "secondary"},
    ],
    "pathways": [{"enzyme": "CYP2C8", "pathway_role": "major"}, {"enzyme": "CYP3A4", "pathway_role": "minor"}],
    "internal_standard": D3_IMATINIB,
}

# Every sample is read out in the secondary stage. The primary stage's minus-NADPH incubation gets NADPH back
# when it is diluted, so it depletes there; the secondary stage's own minus-NADPH control stays flat.
RATES = {
    "Vehicle control (primary)": 0.03,
    "gemfibrozil glucuronide 10 uM (primary)": 0.024,
    "gemfibrozil glucuronide 30 uM (primary)": 0.018,
    "gemfibrozil glucuronide 100 uM (primary)": 0.012,
    "clopidogrel acyl glucuronide (primary)": 0.021,
    "Minus NADPH (primary)": 0.025,
    "Vehicle control (secondary)": 0.03,
    "ketoconazole (secondary)": 0.024,
    "Minus NADPH (secondary)": 0.0,
}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def _post(client: TestClient, fields: dict):
    return client.post("/api/experiments", json=GEMFIBROZIL | fields, headers=FETCH)


def by_label(arms: list[dict]) -> dict[str, dict]:
    return {arm["label"]: arm for arm in arms}


def test_the_gemfibrozil_design_saves_and_reloads_with_its_internal_standard(client: TestClient) -> None:
    created = _post(client, {})
    assert created.status_code == 201, created.text
    experiment = created.json()
    reloaded = client.get(f"/api/experiments/{experiment['id']}").json()
    assert reloaded == experiment
    assert experiment["internal_standard"] == {
        "compound": "D3-imatinib",
        "concentration": 50,
        "concentration_unit": "nM",
        "addition_step": "reaction_termination",
        "solvent": "ice-cold acetonitrile",
        "lot": None,
        "notes": None,
    }
    assert [(s["stage_type"], s["incubation_minutes"], s["protein_concentration"]) for s in experiment["stages"]] == [
        ("primary", 30, 0.5),
        ("secondary", 10, 0.05),
    ]
    assert list(by_label(experiment["arms"])) == list(RATES)


def test_the_internal_standard_is_never_an_arm_a_control_or_a_column(client: TestClient) -> None:
    experiment = _post(client, {}).json()
    arms = experiment["arms"]
    assert not any("imatinib" in arm["label"].lower() for arm in arms)
    assert sum(arm["kind"] == "control" for arm in arms) == 2
    assert sum(arm["kind"] == "negative_control" for arm in arms) == 2
    assert sum(arm["modulator_id"] is not None for arm in arms) == 5
    columns = client.get(f"/api/experiments/{experiment['id']}/measurements").json()["template_columns"]
    assert len(columns) == len(set(columns)) == 1 + len(RATES) * 3
    assert not any("imatinib" in column.lower() for column in columns)


def test_the_gemfibrozil_readout_compares_each_arm_in_its_own_stage_and_counts_cyp2c8_once(client: TestClient) -> None:
    experiment = _post(client, {}).json()
    url = f"/api/experiments/{experiment['id']}"
    rows = [
        {"arm_key": arm["key"], "replicate": r, "timepoint": t, "percent_of_t0": 100 * math.exp(-RATES[arm["label"]] * t)}
        for arm in client.get(f"{url}/measurements").json()["arms"]
        for r in (1, 2, 3)
        for t in TIMES
    ]
    saved = client.put(f"{url}/measurements", json={"rows": rows, "substrate_concentration": 1}, headers=FETCH)
    assert saved.status_code == 200, saved.text
    result = client.get(f"{url}/depletion").json()
    arms = by_label(result["arms"])

    assert result["protein_mg_per_ml"] == pytest.approx(0.05)
    primary_arms = [label for label in RATES if label.endswith("(primary)") and "control" not in label and "Minus" not in label]
    assert {arms[label]["reference_label"] for label in primary_arms} == {"Vehicle control (primary)"}
    assert arms["ketoconazole (secondary)"]["reference_label"] == "Vehicle control (secondary)"

    baseline = arms["Minus NADPH (primary)"]["negative_check"]
    assert (baseline["verdict"], baseline["reason"]) == ("not_judged", "omission ends before the sampled stage; used as baseline")
    assert arms["Minus NADPH (secondary)"]["negative_check"]["verdict"] == "pass"
    assert result["checks"] == [] and result["problems"] == []

    counted = {label: arm["inhibition"]["fm_apparent"] for label, arm in arms.items() if arm["inhibition"] and arm["inhibition"]["fm_counted"]}
    assert counted == {
        "gemfibrozil glucuronide 100 uM (primary)": pytest.approx(0.6, rel=1e-6),
        "ketoconazole (secondary)": pytest.approx(0.2, rel=1e-6),
    }
    assert arms["clopidogrel acyl glucuronide (primary)"]["inhibition"]["fm_note"] == (
        "CYP2C8 counted by gemfibrozil glucuronide 100 uM (primary)"
    )
    assert result["fm_total"] == pytest.approx(0.8, rel=1e-6)


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        (
            {"internal_standard": D3_IMATINIB | {"compound": "Ketoconazole"}},
            "Ketoconazole is an arm's inhibitor, so it can't also be the internal standard",
        ),
        ({"internal_standard": D3_IMATINIB | {"compound": "amodiaquine"}}, "the internal standard can't be the substrate"),
        ({"internal_standard": {"compound": "D3-imatinib", "concentration": 50}}, "the internal standard's concentration needs its unit"),
        ({"internal_standard": D3_IMATINIB | {"addition_step": "before_incubation"}}, "addition_step"),
    ],
)
def test_an_internal_standard_out_of_place_is_refused(client: TestClient, fields: dict, message: str) -> None:
    refused = _post(client, fields)
    assert refused.status_code == 422
    assert message in refused.text


def test_a_cleared_solvent_stays_cleared(client: TestClient) -> None:
    created = _post(client, {"internal_standard": D3_IMATINIB | {"solvent": None}})
    assert created.status_code == 201
    assert created.json()["internal_standard"]["solvent"] is None
    omitted = _post(client, {"code": "WL-IS-2", "internal_standard": D3_IMATINIB})
    assert omitted.json()["internal_standard"]["solvent"] == "ice-cold acetonitrile"


def test_an_experiment_without_an_internal_standard_reports_none(client: TestClient) -> None:
    created = _post(client, {"internal_standard": None})
    assert created.status_code == 201
    assert created.json()["internal_standard"] is None


def _standard(session: Session, **fields) -> ExperimentInternalStandard:
    experiment = Experiment(study_type="substrate_depletion", title="internal standard check")
    session.add(experiment)
    session.flush()
    row = ExperimentInternalStandard(
        experiment_id=experiment.id, compound_id=lookups.compound(session, "D3-imatinib").id, **fields
    )
    session.add(row)
    session.flush()
    return row


@pytest.mark.parametrize(
    ("constraint", "fields"),
    [
        ("ck_internal_standard_addition_step", {"addition_step": "before_incubation"}),
        ("ck_internal_standard_concentration", {"concentration": 0, "concentration_unit": "nM"}),
        ("ck_internal_standard_unit", {"concentration": 50}),
    ],
)
def test_the_database_refuses_a_bad_internal_standard(session: Session, constraint: str, fields: dict) -> None:
    with pytest.raises(IntegrityError) as refused:
        _standard(session, **fields)
    assert refused.value.orig.diag.constraint_name == constraint
    assert constraint in CONSTRAINT_MESSAGES


def test_an_experiment_holds_one_internal_standard(session: Session) -> None:
    first = _standard(session)
    with pytest.raises(IntegrityError) as refused:
        session.add(ExperimentInternalStandard(experiment_id=first.experiment_id, compound_id=first.compound_id))
        session.flush()
    assert refused.value.orig.diag.constraint_name == "uq_lab_expis_experiment"


def test_the_defaults_are_reaction_termination_in_ice_cold_acetonitrile(session: Session) -> None:
    row = _standard(session)
    session.refresh(row)
    assert (row.addition_step, row.solvent) == ("reaction_termination", "ice-cold acetonitrile")
