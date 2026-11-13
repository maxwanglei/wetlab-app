import math
from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import CONSTRAINT_MESSAGES, app
from app.models import (
    AssayMeasurement,
    Experiment,
    ExperimentCofactor,
    ExperimentControl,
    ExperimentModulator,
    ExperimentStage,
    LcmsSample,
    SubstrateDepletionResult,
)
from app.seed.demo import reset
from app.services import lookups

FETCH = {"X-Requested-With": "wetlab"}
TIMES = (0, 5, 15, 30, 45, 60)
PRIMARY = {"stage_type": "primary", "incubation_minutes": 30, "protein_concentration": 0.5}
SECONDARY = {
    "stage_type": "secondary",
    "incubation_minutes": 10,
    "protein_concentration": 0.05,
    "dilution_factor": 10,
    "diluted_from": "primary",
}
NADPH = {"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM"}
UDPGA = {"cofactor": "UDPGA", "role": "cofactor", "concentration": 2, "concentration_unit": "mM"}

SOLVENT_PANEL = {
    "stages": [PRIMARY],
    "condition": {"solvent": "DMSO", "solvent_percentage": 0.1},
    "cofactors": [NADPH, UDPGA],
    "controls": [
        {"control_type": "vehicle", "solvent": "DMSO", "solvent_percentage": 0.1},
        {"control_type": "vehicle", "solvent": "acetonitrile", "solvent_percentage": 0.5},
        {"control_type": "minus_cofactor", "omitted_cofactor": 0},
        {"control_type": "minus_cofactor", "omitted_cofactor": 1},
        {"control_type": "minus_cofactor"},
    ],
    "arms": [
        {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1},
        {"inhibitor": "montelukast", "target_enzyme": "CYP2C8", "concentration": 2, "solvent": "acetonitrile"},
        {"inhibitor": "quinidine", "target_enzyme": "CYP2D6", "concentration": 1, "solvent": "methanol"},
    ],
    "pathways": [{"enzyme": "CYP3A4", "pathway_role": "major"}, {"enzyme": "CYP2C8", "pathway_role": "major"}],
}
STABILITY = {
    "study_type": "substrate_depletion",
    "stages": [PRIMARY],
    "cofactors": [NADPH],
    "controls": [
        {"control_type": "complete"},
        {"control_type": "minus_cofactor", "omitted_cofactor": 0},
        {"control_type": "minus_protein"},
        {"control_type": "heat_inactivated", "protein_concentration": 0.5},
        {"control_type": "minus_substrate"},
        {"control_type": "other", "label": "Buffer only"},
    ],
}
HEPATOCYTES = {
    "study_type": "hepatocyte_stability",
    "stages": [{"stage_type": "primary", "incubation_minutes": 120, "cell_density": 0.5, "cell_density_unit": "million cells/mL"}],
    "condition": {"solvent": "DMSO", "solvent_percentage": 0.1},
    "controls": [{"control_type": "vehicle"}, {"control_type": "heat_inactivated"}, {"control_type": "minus_protein"}],
}
METABOLITE_ID = {
    "study_type": "metabolite_formation",
    "stages": [PRIMARY],
    "cofactors": [NADPH],
    "controls": [
        {"control_type": "complete"},
        {"control_type": "minus_cofactor", "omitted_cofactor": 0},
        {"control_type": "minus_substrate"},
        {"control_type": "minus_protein"},
    ],
}
SERIES = {
    "stages": [PRIMARY, SECONDARY],
    "arms": [
        *({"inhibitor": "gemfibrozil glucuronide", "target_enzyme": "CYP2C8", "concentration": c} for c in (10, 30, 100)),
        *({"inhibitor": "troleandomycin", "target_enzyme": "CYP3A4", "concentration": c} for c in (5, 25, 50)),
        {"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "concentration": 1, "stage": "secondary"},
    ],
    "pathways": [{"enzyme": "CYP3A4", "pathway_role": "major"}, {"enzyme": "CYP2C8", "pathway_role": "major"}],
}


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def _post(client: TestClient, fields: dict):
    body = {"title": "Control design", "study_type": "chemical_inhibition", "substrate": "amodiaquine"} | fields
    return client.post("/api/experiments", json=body, headers=FETCH)


def create(client: TestClient, fields: dict) -> dict:
    created = _post(client, fields)
    assert created.status_code == 201, created.text
    return created.json()


def paste(client: TestClient, experiment: dict, rates: dict[str, float], **body) -> dict:
    """Store three identical replicates per condition, each decaying at its label's rate, and return
    the analysis."""
    url = f"/api/experiments/{experiment['id']}"
    arms = client.get(f"{url}/measurements").json()["arms"]
    rows = [
        {"arm_key": arm["key"], "replicate": r, "timepoint": t, "percent_of_t0": 100 * math.exp(-rates[arm["label"]] * t)}
        for arm in arms
        for r in (1, 2, 3)
        for t in TIMES
    ]
    saved = client.put(f"{url}/measurements", json={"rows": rows, "substrate_concentration": 1} | body, headers=FETCH)
    assert saved.status_code == 200, saved.text
    return client.get(f"{url}/depletion").json()


def by_label(arms: list[dict]) -> dict[str, dict]:
    return {arm["label"]: arm for arm in arms}


def test_multi_target_inhibition_preserves_the_effect_without_assigning_individual_fm(client: TestClient) -> None:
    experiment = create(client, {
        "stages": [PRIMARY],
        "arms": [{"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "also_targets": ["CYP3A5"], "concentration": 1}],
    })
    result = paste(client, experiment, {"Vehicle control": 0.03, "ketoconazole": 0.006})
    inhibition = by_label(result["arms"])["ketoconazole"]["inhibition"]
    assert inhibition["percent"] == pytest.approx(80)
    assert inhibition["significant"] and inhibition["fm_apparent"] is None and not inhibition["fm_counted"]
    assert "CYP3A4, CYP3A5" in inhibition["fm_note"]
    assert result["fm_total"] is None
    saved = client.post(f"/api/experiments/{experiment['id']}/depletion/save", json={"exclusions": []}, headers=FETCH)
    assert saved.status_code == 200
    assert saved.json()["fm_total"] is None


def headers(client: TestClient, experiment: dict) -> list[str]:
    return client.get(f"/api/experiments/{experiment['id']}/measurements").json()["template_columns"]


def saved_references(engine: Engine, experiment_id: int) -> dict[str, tuple[str | None, float | None]]:
    """Each saved row's subject key mapped to the key of the control it was normalised against and the
    rate it recorded for that control."""
    with Session(engine) as session:
        rows = session.execute(
            select(
                SubstrateDepletionResult.experiment_modulator_id,
                SubstrateDepletionResult.experiment_control_id,
                SubstrateDepletionResult.reference_control_id,
                SubstrateDepletionResult.control_depletion_rate,
            ).where(SubstrateDepletionResult.experiment_id == experiment_id)
        ).all()
    return {
        (f"arm-{modulator}" if modulator else f"ctl-{control}"): (
            f"ctl-{reference}" if reference else None,
            float(rate) if rate is not None else None,
        )
        for modulator, control, reference, rate in rows
    }


def test_each_inhibitor_is_compared_against_the_vehicle_in_its_own_solvent(client: TestClient, engine: Engine) -> None:
    experiment = create(client, SOLVENT_PANEL)
    arms = by_label(experiment["arms"])
    assert list(arms) == [
        "Vehicle control (DMSO 0.1%)",
        "Vehicle control (acetonitrile 0.5%)",
        "ketoconazole",
        "montelukast",
        "quinidine",
        "Minus NADPH",
        "Minus UDPGA",
        "Minus all cofactors",
    ]
    assert [arm["kind"] for arm in arms.values()] == ["control"] * 2 + ["inhibitor"] * 2 + ["selectivity_control"] + ["negative_control"] * 3
    assert (arms["ketoconazole"]["reference_label"], arms["ketoconazole"]["reference_source"]) == ("Vehicle control (DMSO 0.1%)", "matched")
    assert arms["montelukast"]["reference_label"] == "Vehicle control (acetonitrile 0.5%)"
    assert arms["quinidine"]["reference_key"] is None
    assert arms["Minus UDPGA"]["omitted_cofactor"] == "UDPGA" and arms["Minus all cofactors"]["omitted_cofactor"] == "all"
    columns = headers(client, experiment)
    assert len(columns) == len(set(columns)) == 1 + 8 * 3

    result = paste(
        client,
        experiment,
        {
            "Vehicle control (DMSO 0.1%)": 0.03,
            "Vehicle control (acetonitrile 0.5%)": 0.024,
            "ketoconazole": 0.006,
            "montelukast": 0.012,
            "quinidine": 0.03,
            "Minus NADPH": 0.0,
            "Minus UDPGA": 0.0005,
            "Minus all cofactors": -0.0002,
        },
    )
    assert result["problems"] == ["quinidine: no reference control in the primary stage matches its solvent; choose one on the arm"]
    assert result["checks"] == []
    analysed = by_label(result["arms"])
    assert analysed["ketoconazole"]["inhibition"]["percent"] == pytest.approx(80, rel=1e-6)
    assert analysed["montelukast"]["inhibition"]["percent"] == pytest.approx(50, rel=1e-6)
    assert analysed["quinidine"]["inhibition"] is None
    for label in ("Minus NADPH", "Minus UDPGA", "Minus all cofactors"):
        negative = analysed[label]
        assert negative["negative_check"]["verdict"] == "pass"
        assert negative["fit"]["clint_app"] is None and negative["fit"]["problem"] is None
        assert negative["reference_label"] == "Vehicle control (DMSO 0.1%)"
    assert result["method"].endswith("at its last timepoint, or no measurable loss.")

    saved = client.post(f"/api/experiments/{experiment['id']}/depletion/save", json={"exclusions": []}, headers=FETCH)
    assert saved.status_code == 200, saved.text
    rates = {arm["key"]: arm["fit"]["k"] for arm in result["arms"]}
    expected = {
        arm["key"]: arm["key"] if arm["kind"] == "control" else arm["reference_key"] for arm in result["arms"]
    }
    stored = saved_references(engine, experiment["id"])
    assert {key: reference for key, (reference, _) in stored.items()} == expected
    for reference, rate in stored.values():
        assert rate == (pytest.approx(rates[reference], rel=1e-12) if reference else None)


def test_a_stability_run_with_a_full_negative_panel_has_no_problem_lines(client: TestClient) -> None:
    experiment = create(client, STABILITY)
    arms = by_label(experiment["arms"])
    assert {label: arm["kind"] for label, arm in arms.items()} == {
        "Complete incubation": "control",
        "Minus NADPH": "negative_control",
        "Minus protein": "negative_control",
        "Heat-inactivated 0.5 mg/mL": "negative_control",
        "Minus substrate": "negative_control",
        "Buffer only": "negative_control",
    }
    assert arms["Heat-inactivated 0.5 mg/mL"]["protein_override"] == 0.5
    columns = headers(client, experiment)
    assert not any(column.startswith("Minus substrate") for column in columns)
    assert len(columns) == 1 + 5 * 3

    result = paste(
        client,
        experiment,
        {"Complete incubation": 0.03, "Minus NADPH": 0, "Minus protein": 0, "Heat-inactivated 0.5 mg/mL": 0.002, "Buffer only": 0},
    )
    assert result["problems"] == [] and result["checks"] == []
    verdicts = {arm["label"]: arm["negative_check"]["verdict"] for arm in result["arms"] if arm["negative_check"]}
    assert verdicts == dict.fromkeys(["Minus NADPH", "Minus protein", "Heat-inactivated 0.5 mg/mL", "Buffer only"], "pass")
    assert by_label(result["arms"])["Complete incubation"]["fit"]["clint_app"] == pytest.approx(0.03 * 1000 / 0.5, rel=1e-6)


def test_a_negative_that_loses_parent_is_a_check_on_the_run_not_a_problem(client: TestClient) -> None:
    experiment = create(client, STABILITY)
    result = paste(
        client,
        experiment,
        {"Complete incubation": 0.03, "Minus NADPH": 0.01, "Minus protein": 0, "Heat-inactivated 0.5 mg/mL": 0, "Buffer only": 0},
    )
    assert result["problems"] == []
    assert result["checks"] == ["Minus NADPH: 54.8% remaining at 60 min (threshold 80%)"]
    check = by_label(result["arms"])["Minus NADPH"]["negative_check"]
    assert (check["verdict"], check["threshold_percent"]) == ("flag", 80)
    assert check["k_ratio"] == pytest.approx(1 / 3, rel=1e-6)
    assert check["dependent_share"] == pytest.approx(2 / 3, rel=1e-6)


def test_a_hepatocyte_run_names_killed_cells_and_no_cells(client: TestClient) -> None:
    experiment = create(client, HEPATOCYTES)
    assert [(arm["label"], arm["kind"]) for arm in experiment["arms"]] == [
        ("Vehicle control", "control"),
        ("Heat-inactivated", "negative_control"),
        ("No cells", "negative_control"),
    ]
    result = paste(client, experiment, {"Vehicle control": 0.02, "Heat-inactivated": 0, "No cells": 0})
    assert all(arm["negative_check"]["verdict"] == "pass" for arm in result["arms"] if arm["kind"] == "negative_control")
    assert not any(problem.startswith(("Heat-inactivated", "No cells")) for problem in result["problems"])


def test_the_metabolite_id_design_reads_as_one_reference_and_three_negatives(client: TestClient) -> None:
    experiment = create(client, METABOLITE_ID)
    expected = [
        ("Complete incubation", "control", "complete"),
        ("Minus NADPH", "negative_control", "minus_cofactor"),
        ("Minus substrate", "negative_control", "minus_substrate"),
        ("Minus protein", "negative_control", "minus_protein"),
    ]
    assert [(arm["label"], arm["kind"], arm["control_type"]) for arm in experiment["arms"]] == expected
    reloaded = client.get(f"/api/experiments/{experiment['id']}").json()
    assert reloaded["arms"] == experiment["arms"]
    assert headers(client, experiment) == ["Time (min)"] + [
        f"{label} R{r}" for label in ("Complete incubation", "Minus NADPH", "Minus protein") for r in (1, 2, 3)
    ]


def test_w7_a_series_per_stage_is_stored_and_rendered_back(client: TestClient, engine: Engine) -> None:
    experiment = create(client, SERIES)
    primary = [
        "gemfibrozil glucuronide 10 uM (primary)",
        "gemfibrozil glucuronide 30 uM (primary)",
        "gemfibrozil glucuronide 100 uM (primary)",
        "troleandomycin 5 uM (primary)",
        "troleandomycin 25 uM (primary)",
        "troleandomycin 50 uM (primary)",
    ]
    reloaded = client.get(f"/api/experiments/{experiment['id']}").json()
    assert reloaded["arms"] == experiment["arms"]
    arms = by_label(reloaded["arms"])
    assert list(arms) == ["Vehicle control (primary)", *primary, "Vehicle control (secondary)", "ketoconazole (secondary)"]
    assert {arms[label]["stage"] for label in primary} == {"primary"}
    assert {arms[label]["reference_label"] for label in primary} == {"Vehicle control (primary)"}
    assert arms["ketoconazole (secondary)"]["stage"] == "secondary"
    assert arms["ketoconazole (secondary)"]["reference_label"] == "Vehicle control (secondary)"
    assert [arms[label]["concentration"] for label in primary] == [10, 30, 100, 5, 25, 50]
    assert len({arms[label]["group_key"] for label in primary[:3]}) == 1
    assert arms[primary[0]]["group_key"] != arms[primary[3]]["group_key"]
    with Session(engine) as session:
        stored = session.execute(
            select(ExperimentStage.stage_type, ExperimentModulator.modulator_concentration)
            .join(ExperimentStage, ExperimentStage.id == ExperimentModulator.stage_id)
            .where(ExperimentModulator.experiment_id == experiment["id"])
            .order_by(ExperimentModulator.id)
        ).all()
    assert [(stage, float(c)) for stage, c in stored] == [("primary", c) for c in (10, 30, 100, 5, 25, 50)] + [("secondary", 1)]

    vehicle = 0.03
    result = paste(
        client,
        experiment,
        {
            "Vehicle control (primary)": vehicle,
            "gemfibrozil glucuronide 10 uM (primary)": 0.027,
            "gemfibrozil glucuronide 30 uM (primary)": 0.024,
            "gemfibrozil glucuronide 100 uM (primary)": 0.021,
            "troleandomycin 5 uM (primary)": 0.025,
            "troleandomycin 25 uM (primary)": 0.02,
            "troleandomycin 50 uM (primary)": 0.015,
            "Vehicle control (secondary)": vehicle,
            "ketoconazole (secondary)": 0.02,
        },
    )
    counted = {arm["label"]: arm["inhibition"]["fm_apparent"] for arm in result["arms"] if arm["inhibition"] and arm["inhibition"]["fm_counted"]}
    assert counted == {
        "gemfibrozil glucuronide 100 uM (primary)": pytest.approx(0.3, rel=1e-6),
        "troleandomycin 50 uM (primary)": pytest.approx(0.5, rel=1e-6),
    }
    assert result["fm_total"] == pytest.approx(0.8, rel=1e-6)
    notes = by_label(result["arms"])
    assert notes["ketoconazole (secondary)"]["inhibition"]["fm_note"] == "CYP3A4 counted by troleandomycin 50 uM (primary)"


def test_w8_the_same_control_type_saves_in_both_stages_and_twice_in_one(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY, SECONDARY],
            "cofactors": [NADPH, UDPGA],
            "controls": [
                {"stage": "primary", "control_type": "vehicle"},
                {"stage": "primary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
                {"stage": "primary", "control_type": "minus_cofactor", "omitted_cofactor": 1},
                {"stage": "secondary", "control_type": "vehicle"},
                {"stage": "secondary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
            ],
            "arms": [
                {"inhibitor": "gemfibrozil glucuronide", "target_enzyme": "CYP2C8", "concentration": 30},
                {"inhibitor": "gemfibrozil glucuronide", "target_enzyme": "CYP2C8", "concentration": 30, "cofactor_omitted": True, "omitted_cofactor": 0},
            ],
        },
    )
    arms = by_label(experiment["arms"])
    assert list(arms) == [
        "Vehicle control (primary)",
        "gemfibrozil glucuronide (primary)",
        "gemfibrozil glucuronide minus NADPH (primary)",
        "Minus NADPH (primary)",
        "Minus UDPGA (primary)",
        "Vehicle control (secondary)",
        "Minus NADPH (secondary)",
    ]
    twin = arms["gemfibrozil glucuronide minus NADPH (primary)"]
    assert (twin["cofactor_omitted"], twin["omitted_cofactor"], twin["reference_label"]) == (True, "NADPH", "Minus NADPH (primary)")
    assert arms["gemfibrozil glucuronide (primary)"]["reference_label"] == "Vehicle control (primary)"


def test_a_minus_cofactor_vehicle_read_in_a_later_stage_is_a_baseline(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY, SECONDARY],
            "cofactors": [NADPH],
            "controls": [
                {"stage": "primary", "control_type": "vehicle"},
                {"stage": "primary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
                {"stage": "secondary", "control_type": "vehicle"},
                {"stage": "secondary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
            ],
        },
    )
    rates = {"Vehicle control (primary)": 0.03, "Minus NADPH (primary)": 0.03, "Vehicle control (secondary)": 0.03, "Minus NADPH (secondary)": 0}
    result = paste(client, experiment, rates)
    checks = {arm["label"]: arm["negative_check"] for arm in result["arms"] if arm["negative_check"]}
    assert (checks["Minus NADPH (primary)"]["verdict"], checks["Minus NADPH (primary)"]["reason"]) == (
        "not_judged",
        "omission ends before the sampled stage; used as baseline",
    )
    assert checks["Minus NADPH (secondary)"]["verdict"] == "pass"
    assert result["checks"] == []


def test_an_explicit_reference_overrides_solvent_matching(client: TestClient) -> None:
    panel = SOLVENT_PANEL | {"arms": [{"inhibitor": "quinidine", "concentration": 1, "solvent": "methanol", "reference_control": 1}]}
    arm = by_label(create(client, panel)["arms"])["quinidine"]
    assert (arm["reference_label"], arm["reference_source"], arm["reference_problem"]) == (
        "Vehicle control (acetonitrile 0.5%)",
        "explicit",
        None,
    )


def test_a_lone_vehicle_in_another_solvent_is_used_with_a_check(client: TestClient) -> None:
    experiment = create(
        client,
        {"stages": [PRIMARY], "condition": {"solvent": "DMSO"}, "arms": [{"inhibitor": "quinidine", "concentration": 1, "solvent": "methanol"}]},
    )
    result = paste(client, experiment, {"Vehicle control": 0.03, "quinidine": 0.03})
    assert result["problems"] == []
    assert result["checks"] == ["quinidine: no reference control in methanol; compared against Vehicle control"]
    assert by_label(result["arms"])["quinidine"]["reference_source"] == "fallback"


def test_omitted_controls_default_to_one_vehicle_per_stage_and_an_empty_list_means_none(client: TestClient) -> None:
    defaulted = create(client, {"stages": [PRIMARY, SECONDARY]})
    assert [(arm["label"], arm["stage"]) for arm in defaulted["arms"]] == [
        ("Vehicle control (primary)", "primary"),
        ("Vehicle control (secondary)", "secondary"),
    ]
    assert create(client, {"stages": [PRIMARY], "controls": []})["arms"] == []


def test_without_any_reference_the_legacy_line_is_kept(client: TestClient) -> None:
    experiment = create(client, {"stages": [PRIMARY], "controls": [], "arms": [{"inhibitor": "ketoconazole", "concentration": 1}]})
    result = paste(client, experiment, {"ketoconazole": 0.01})
    assert result["problems"] == ["no vehicle control arm, so no % inhibition or fm"]


def test_the_sample_experiment_keeps_its_paste_headers_and_saves_the_vehicle_as_reference(client: TestClient, engine: Engine) -> None:
    experiment = next(e for e in client.get("/api/experiments").json() if e["code"] == "WL-2026-047")
    assert headers(client, experiment) == ["Time (min)"] + [
        f"{label} R{r}" for label in ("Vehicle control", "montelukast", "ketoconazole", "quinidine") for r in (1, 2, 3)
    ]
    url = f"/api/experiments/{experiment['id']}/depletion"
    result = client.get(url).json()
    assert client.post(f"{url}/save", json={"exclusions": []}, headers=FETCH).status_code == 200
    vehicle = next(arm for arm in result["arms"] if arm["kind"] == "control")
    stored = saved_references(engine, experiment["id"])
    assert set(stored) == {arm["key"] for arm in result["arms"]}
    assert {reference for reference, _ in stored.values()} == {vehicle["key"]}
    assert all(rate == pytest.approx(vehicle["fit"]["k"], rel=1e-12) for _, rate in stored.values())


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        (
            {"controls": [{"control_type": "vehicle", "label": "Vehicle A"}, {"control_type": "vehicle", "label": " vehicle a "}]},
            "two controls in the primary stage share the label vehicle a",
        ),
        (
            {
                "stages": [PRIMARY, SECONDARY],
                "controls": [{"stage": "primary", "control_type": "vehicle"}, {"stage": "secondary", "control_type": "vehicle"}],
                "arms": [{"inhibitor": "ketoconazole", "stage": "secondary", "reference_control": 0}],
            },
            "arm 1's reference control must be in the arm's own stage",
        ),
        (
            {"cofactors": [NADPH], "controls": [{"control_type": "vehicle", "omitted_cofactor": 0}]},
            "only a minus-cofactor control can name an omitted cofactor",
        ),
        ({"controls": [{"control_type": "complete", "solvent": "DMSO"}]}, "a complete incubation has no added solvent"),
        ({"controls": [{"control_type": "vehicle", "solvent": "None"}]}, "a complete incubation, not a vehicle"),
        ({"controls": [{"control_type": "other"}]}, "a control of type other needs a label"),
        ({"controls": [{"control_type": "vehicle", "protein_concentration": 0.5}]}, "only heat-inactivated and other controls"),
        ({"controls": [{"stage": "secondary", "control_type": "vehicle"}]}, "control 1 names the secondary stage"),
        ({"controls": [{"control_type": "minus_cofactor", "omitted_cofactor": 0}]}, "control 1 omits cofactor 1, which is not listed"),
        (
            {"cofactors": [NADPH], "arms": [{"inhibitor": "ketoconazole", "omitted_cofactor": 0}]},
            "only when its cofactor is omitted",
        ),
        (
            {"controls": [{"control_type": "minus_protein"}], "arms": [{"inhibitor": "ketoconazole", "reference_control": 0}]},
            "arm 1's reference must be a vehicle or a complete incubation",
        ),
        (
            {"controls": [{"control_type": "vehicle"}], "arms": [{"inhibitor": "ketoconazole", "cofactor_omitted": True, "reference_control": 0}]},
            "arm 1 omits a cofactor, so its reference must be a control omitting the same one",
        ),
        ({"arms": [{"inhibitor": "ketoconazole", "reference_control": 0}]}, "arm 1 names control 1, which is not listed"),
        ({"arms": [{"inhibitor": "ketoconazole", "also_targets": ["CYP3A5"]}]}, "further targets only after its target enzyme"),
        (
            {"arms": [{"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "also_targets": ["cyp3a4"]}]},
            "names cyp3a4 as a target more than once",
        ),
        (
            {"arms": [{"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4", "also_targets": ["CYP3A5", "CYP3A5"]}]},
            "names CYP3A5 as a target more than once",
        ),
    ],
)
def test_a_design_out_of_shape_is_refused_in_plain_words(client: TestClient, fields: dict, message: str) -> None:
    refused = _post(client, fields)
    assert refused.status_code == 422
    assert message in refused.text


def test_a_repeated_arm_is_refused_with_its_stage_and_cofactor_condition(client: TestClient) -> None:
    arm = {"inhibitor": "ketoconazole", "concentration": 1}
    refused = _post(client, {"arms": [arm, arm]})
    assert (refused.status_code, refused.json()["detail"]) == (409, CONSTRAINT_MESSAGES["uq_lab_expmod_arm"])
    assert _post(client, {"cofactors": [NADPH], "arms": [arm, arm | {"cofactor_omitted": True}]}).status_code == 201


def _design(session: Session) -> tuple[Experiment, ExperimentStage]:
    experiment = Experiment(study_type="substrate_depletion", title="constraint check")
    session.add(experiment)
    session.flush()
    stage = ExperimentStage(experiment_id=experiment.id, stage_type="primary", sequence=1)
    session.add(stage)
    session.flush()
    return experiment, stage


def _add(session: Session, row):
    session.add(row)
    session.flush()
    return row


def _control(session: Session, experiment: Experiment, stage: ExperimentStage, **fields) -> ExperimentControl:
    return _add(
        session,
        ExperimentControl(experiment_id=experiment.id, stage_id=stage.id, **({"control_type": "vehicle", "label": "Vehicle control"} | fields)),
    )


def _cofactor(session: Session, experiment: Experiment) -> ExperimentCofactor:
    return _add(session, ExperimentCofactor(experiment_id=experiment.id, cofactor="NADPH"))


def _modulator(session: Session, experiment: Experiment, stage: ExperimentStage, **fields) -> ExperimentModulator:
    compound = lookups.compound(session, "ketoconazole")
    return _add(
        session,
        ExperimentModulator(experiment_id=experiment.id, stage_id=stage.id, modulator_compound_id=compound.id, **fields),
    )


def _measurement(experiment: Experiment, **fields) -> AssayMeasurement:
    return AssayMeasurement(experiment_id=experiment.id, timepoint=0, measured_entity="parent_remaining", **fields)


def _second_stage(session: Session, experiment: Experiment) -> ExperimentStage:
    return _add(session, ExperimentStage(experiment_id=experiment.id, stage_type="secondary", sequence=2))


Violation = Callable[[Session, Experiment, ExperimentStage], object]
VIOLATIONS: dict[str, Violation] = {
    "ck_experiment_control_type": lambda s, e, st: _control(s, e, st, control_type="positive"),
    "ck_experiment_control_label": lambda s, e, st: _control(s, e, st, label="  "),
    "ck_experiment_control_solvent_percentage": lambda s, e, st: _control(s, e, st, solvent_percentage=150),
    "ck_experiment_control_protein": lambda s, e, st: _control(s, e, st, control_type="other", protein_concentration=-1),
    "ck_experiment_control_omitted_only_minus_cofactor": lambda s, e, st: _control(s, e, st, omitted_cofactor_id=_cofactor(s, e).id),
    "ck_experiment_control_complete_no_solvent": lambda s, e, st: _control(s, e, st, control_type="complete", solvent="DMSO"),
    "ck_experiment_control_vehicle_names_solvent": lambda s, e, st: _control(s, e, st, solvent=" None "),
    "ck_experiment_control_protein_override": lambda s, e, st: _control(s, e, st, protein_concentration=0.5),
    "uq_lab_expcontrol_label": lambda s, e, st: (_control(s, e, st, label="Minus NADPH"), _control(s, e, st, label=" minus nadph")),
    "fk_lab_expcontrol_stage": lambda s, e, st: _control(s, _design(s)[0], st),
    "fk_lab_expcontrol_omitted_cofactor": lambda s, e, st: _control(
        s, e, st, control_type="minus_cofactor", omitted_cofactor_id=_cofactor(s, _design(s)[0]).id
    ),
    "ck_experiment_modulator_solvent_percentage": lambda s, e, st: _modulator(s, e, st, solvent_percentage=-1),
    "ck_experiment_modulator_omitted_requires_flag": lambda s, e, st: _modulator(s, e, st, omitted_cofactor_id=_cofactor(s, e).id),
    "fk_lab_expmod_stage": lambda s, e, st: _modulator(s, _design(s)[0], st),
    "fk_lab_expmod_omitted_cofactor": lambda s, e, st: _modulator(
        s, e, st, cofactor_omitted=True, omitted_cofactor_id=_cofactor(s, _design(s)[0]).id
    ),
    "fk_lab_expmod_reference": lambda s, e, st: _modulator(s, e, _second_stage(s, e), reference_control_id=_control(s, e, st).id),
    "uq_lab_expmod_arm": lambda s, e, st: (_modulator(s, e, st, modulator_concentration=1), _modulator(s, e, st, modulator_concentration=1)),
    "ck_assay_measurement_one_subject": lambda s, e, st: _add(
        s, _measurement(e, experiment_modulator_id=_modulator(s, e, st).id, experiment_control_id=_control(s, e, st).id)
    ),
    "fk_lab_measurement_control": lambda s, e, st: _add(s, _measurement(e, experiment_control_id=_control(s, *_design(s)).id)),
    "ck_sdr_one_subject": lambda s, e, st: _add(
        s,
        SubstrateDepletionResult(
            experiment_id=e.id, experiment_modulator_id=_modulator(s, e, st).id, experiment_control_id=_control(s, e, st).id
        ),
    ),
    "fk_lab_sdr_reference": lambda s, e, st: _add(
        s, SubstrateDepletionResult(experiment_id=e.id, reference_control_id=_control(s, *_design(s)).id)
    ),
    "ck_lcms_sample_control_has_experiment": lambda s, e, st: _add(
        s, LcmsSample(sample_type="study", experiment_control_id=_control(s, e, st).id)
    ),
    "fk_lab_lcms_sample_control": lambda s, e, st: _add(
        s, LcmsSample(sample_type="study", experiment_id=e.id, experiment_control_id=_control(s, *_design(s)).id)
    ),
}


@pytest.mark.parametrize("constraint", list(VIOLATIONS))
def test_the_database_refuses_each_bad_row_by_name(session: Session, constraint: str) -> None:
    with pytest.raises(IntegrityError) as refused:
        VIOLATIONS[constraint](session, *_design(session))
    assert refused.value.orig.diag.constraint_name == constraint
    assert constraint in CONSTRAINT_MESSAGES


def test_every_constraint_with_a_message_exists(engine: Engine) -> None:
    with engine.connect() as connection:
        names = set(
            connection.scalars(
                text(
                    "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'lab' "
                    "UNION SELECT indexname FROM pg_indexes WHERE schemaname = 'lab'"
                )
            )
        )
    assert set(CONSTRAINT_MESSAGES) - names == set()


# Constraints no request can break: composite-key targets that include the primary key, values the app
# computes itself, and mass-spectrometry tables nothing writes yet.
UNREACHABLE = {
    "uq_lab_expcofactor_id_experiment",
    "uq_lab_expcontrol_id_experiment",
    "uq_lab_expcontrol_id_experiment_stage",
    "uq_lab_expstage_id_experiment",
    "ck_expmod_extra_target_position",
    "ck_sdr_n_points_used",
    "ck_sdr_r_squared",
    "uq_lab_lcms_peak_assay_measurement",
    "uq_lab_lcms_peak_channel",
    "uq_lab_lcms_transition_quantifier",
}


def test_every_named_constraint_a_user_can_break_has_a_message(engine: Engine) -> None:
    with engine.connect() as connection:
        names = set(
            connection.scalars(
                text(
                    "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace "
                    "WHERE n.nspname = 'lab' AND (conname LIKE 'fk\\_lab\\_%' OR conname LIKE 'ck\\_%' OR conname LIKE 'uq\\_lab\\_%') "
                    "UNION SELECT indexname FROM pg_indexes WHERE schemaname = 'lab' AND indexname LIKE 'uq\\_lab\\_%'"
                )
            )
        )
    assert names - UNREACHABLE - set(CONSTRAINT_MESSAGES) == set()


def test_an_arm_in_a_stage_without_a_reference_is_a_problem_when_another_stage_has_one(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY, SECONDARY],
            "controls": [{"stage": "primary", "control_type": "vehicle"}],
            "arms": [{"inhibitor": "ketoconazole", "concentration": 1, "stage": "secondary"}],
        },
    )
    result = paste(client, experiment, {"Vehicle control (primary)": 0.03, "ketoconazole (secondary)": 0.01})
    assert "ketoconazole (secondary): no reference control in the secondary stage, so no % inhibition" in result["problems"]


def test_a_twin_without_a_control_leaving_out_its_cofactor_is_a_problem(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY],
            "cofactors": [NADPH],
            "arms": [{"inhibitor": "ketoconazole", "concentration": 1, "cofactor_omitted": True, "omitted_cofactor": 0}],
        },
    )
    result = paste(client, experiment, {"Vehicle control": 0.03, "ketoconazole minus NADPH": 0.01})
    assert result["problems"] == [
        "ketoconazole minus NADPH: no control in the primary stage leaves out the same cofactor, so no % inhibition"
    ]


def test_an_arm_whose_reference_has_no_measurements_says_so(client: TestClient) -> None:
    """With one reference, the analysis's own line says so, worded as before; with several, the arm names its own."""
    single = create(client, {"stages": [PRIMARY], "arms": [{"inhibitor": "ketoconazole", "concentration": 1}]})
    several = create(client, SOLVENT_PANEL)
    for experiment, unsampled in ((single, "Vehicle control"), (several, "Vehicle control (DMSO 0.1%)")):
        url = f"/api/experiments/{experiment['id']}"
        rows = [
            {"arm_key": arm["key"], "replicate": 1, "timepoint": t, "percent_of_t0": 100 * math.exp(-0.01 * t)}
            for arm in experiment["arms"]
            if arm["label"] != unsampled
            for t in TIMES
        ]
        assert client.put(f"{url}/measurements", json={"rows": rows, "substrate_concentration": 1}, headers=FETCH).status_code == 200
        problems = client.get(f"{url}/depletion").json()["problems"]
        if experiment is single:
            assert problems == ["no vehicle control arm, so no % inhibition or fm"]
        else:
            assert "ketoconazole: its reference Vehicle control (DMSO 0.1%) has no measurements, so no % inhibition" in problems
            assert "no vehicle control arm, so no % inhibition or fm" not in problems


def test_a_flat_minus_cofactor_control_needs_its_cofactor_for_all_the_loss(client: TestClient) -> None:
    experiment = create(client, STABILITY)
    result = paste(
        client,
        experiment,
        {"Complete incubation": 0.03, "Minus NADPH": 0, "Minus protein": 0, "Heat-inactivated 0.5 mg/mL": 0, "Buffer only": 0},
    )
    check = by_label(result["arms"])["Minus NADPH"]["negative_check"]
    assert check["k_ratio"] == pytest.approx(0, abs=1e-9)
    assert check["dependent_share"] == pytest.approx(1)


def test_a_baseline_negative_keeps_its_numbers_and_saves_them(client: TestClient, engine: Engine) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY, SECONDARY],
            "cofactors": [NADPH],
            "controls": [
                {"stage": "primary", "control_type": "vehicle"},
                {"stage": "primary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
                {"stage": "secondary", "control_type": "vehicle"},
            ],
        },
    )
    result = paste(client, experiment, {"Vehicle control (primary)": 0.03, "Minus NADPH (primary)": 0.02, "Vehicle control (secondary)": 0.03})
    check = by_label(result["arms"])["Minus NADPH (primary)"]["negative_check"]
    assert check["verdict"] == "not_judged" and check["percent_remaining_last"] == pytest.approx(100 * math.exp(-0.02 * 60))
    assert check["dependent_share"] is None, "a baseline was read with its cofactor back"
    assert client.post(f"/api/experiments/{experiment['id']}/depletion/save", json={"exclusions": []}, headers=FETCH).status_code == 200
    with Session(engine) as session:
        saved = session.scalar(
            select(SubstrateDepletionResult.mean_value).where(
                SubstrateDepletionResult.experiment_id == experiment["id"],
                SubstrateDepletionResult.value_unit == "% of T0 at last timepoint",
            )
        )
    assert float(saved) == pytest.approx(100 * math.exp(-0.02 * 60))


def test_an_arm_inheriting_the_incubation_percentage_matches_the_vehicle_at_that_percentage(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "condition": {"solvent": "DMSO", "solvent_percentage": 0.5},
            "controls": [
                {"control_type": "vehicle", "label": "DMSO 0.1%", "solvent": "DMSO", "solvent_percentage": 0.1},
                {"control_type": "vehicle", "label": "DMSO 0.5%", "solvent": "DMSO", "solvent_percentage": 0.5},
            ],
            "arms": [{"inhibitor": "ketoconazole", "concentration": 1}],
        },
    )
    arm = by_label(experiment["arms"])["ketoconazole"]
    assert (arm["solvent_percentage"], arm["reference_label"], arm["reference_problem"]) == (0.5, "DMSO 0.5%", None)


def test_two_vehicles_in_one_solvent_are_matched_by_each_condition_s_time_in_the_stage(client: TestClient) -> None:
    """The tucatinib protocol's primary stage: the gem-gluc set runs 30 min and the CYP3cide set the stage's 5."""
    experiment = create(
        client,
        {
            "stages": [PRIMARY | {"incubation_minutes": 5}],
            "condition": {"solvent": "DMSO", "solvent_percentage": 0.5},
            "cofactors": [NADPH],
            "controls": [
                {"control_type": "vehicle", "label": "Vehicle, gem-gluc set", "incubation_minutes": 30},
                {"control_type": "vehicle", "label": "Vehicle, CYP3cide set"},
                {"control_type": "minus_cofactor", "label": "Minus NADPH, gem-gluc set", "omitted_cofactor": 0, "incubation_minutes": 30, "replicates": 1},
                {"control_type": "minus_cofactor", "label": "Minus NADPH, CYP3cide set", "omitted_cofactor": 0, "replicates": 1},
            ],
            "arms": [
                {"inhibitor": "gemfibrozil glucuronide", "concentration": 64, "incubation_minutes": 30},
                {"inhibitor": "gemfibrozil glucuronide", "concentration": 64, "incubation_minutes": 30, "cofactor_omitted": True, "omitted_cofactor": 0, "replicates": 1},
                {"inhibitor": "CYP3cide", "concentration": 1.3},
                {"inhibitor": "CYP3cide", "concentration": 1.3, "cofactor_omitted": True, "omitted_cofactor": 0, "replicates": 1},
            ],
        },
    )
    arms = by_label(experiment["arms"])
    assert {label: (arm["reference_label"], arm["reference_problem"]) for label, arm in arms.items() if arm["kind"] != "control"} == {
        "gemfibrozil glucuronide": ("Vehicle, gem-gluc set", None),
        "gemfibrozil glucuronide minus NADPH": ("Minus NADPH, gem-gluc set", None),
        "CYP3cide": ("Vehicle, CYP3cide set", None),
        "CYP3cide minus NADPH": ("Minus NADPH, CYP3cide set", None),
        "Minus NADPH, gem-gluc set": ("Vehicle, gem-gluc set", None),
        "Minus NADPH, CYP3cide set": ("Vehicle, CYP3cide set", None),
    }
    assert [(arm["incubation_minutes"], arm["replicates"]) for arm in arms.values()] == [
        (30, 3), (5, 3), (30, 3), (30, 1), (5, 3), (5, 1), (30, 1), (5, 1)
    ]


def test_a_negative_control_that_cannot_choose_among_its_stage_s_references_says_why(client: TestClient) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY, SECONDARY],
            "cofactors": [NADPH],
            "controls": [
                {"stage": "primary", "control_type": "vehicle", "label": "Vehicle A", "solvent": "DMSO"},
                {"stage": "primary", "control_type": "vehicle", "label": "Vehicle B", "solvent": "DMSO"},
                {"stage": "primary", "control_type": "minus_cofactor", "solvent": "DMSO", "omitted_cofactor": 0},
                {"stage": "secondary", "control_type": "minus_cofactor", "omitted_cofactor": 0},
            ],
        },
    )
    arms = by_label(experiment["arms"])
    assert (arms["Minus NADPH (primary)"]["reference_key"], arms["Minus NADPH (primary)"]["reference_problem"]) == (
        None,
        "Minus NADPH (primary): 2 reference controls match in the primary stage; give it the solvent and time of the one it goes with",
    )
    assert arms["Minus NADPH (secondary)"]["reference_problem"] is None


def test_paste_preview_for_an_experiment_with_nothing_to_paste_is_an_error_not_a_crash(client: TestClient) -> None:
    experiment = create(client, {"controls": [{"control_type": "minus_substrate"}]})
    preview = client.post(f"/api/experiments/{experiment['id']}/measurements/paste-preview", json={"text": "0\t100"}, headers=FETCH)
    assert preview.status_code == 200
    assert preview.json()["errors"] == ["This experiment has no condition to paste values for."]


def test_saving_a_counted_arm_without_a_concentration_records_its_fm(client: TestClient, engine: Engine) -> None:
    experiment = create(
        client,
        {
            "stages": [PRIMARY],
            "arms": [{"inhibitor": "ketoconazole", "target_enzyme": "CYP3A4"}],
            "pathways": [{"enzyme": "CYP3A4", "pathway_role": "major"}],
        },
    )
    paste(client, experiment, {"Vehicle control": 0.03, "ketoconazole": 0.012})
    assert client.post(f"/api/experiments/{experiment['id']}/depletion/save", json={"exclusions": []}, headers=FETCH).status_code == 200
    with Session(engine) as session:
        basis = session.scalar(
            select(SubstrateDepletionResult.fm_basis).where(SubstrateDepletionResult.experiment_id == experiment["id"]).where(
                SubstrateDepletionResult.fm_basis.is_not(None)
            )
        )
    assert basis == "apparent fm from chemical inhibition: ketoconazole -> CYP3A4"
