from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_engine
from app.main import CONSTRAINT_MESSAGES, app
from app.models import Experiment, ExperimentCofactor, PreparedSolution, Reagent, ReagentComponent, ReagentLot
from app.seed.demo import reset

FETCH = {"X-Requested-With": "wetlab"}
SOLUTION_A = [
    {"component_name": "NADP+", "amount": 1.3, "amount_unit": "mM"},
    {"component_name": "glucose-6-phosphate", "amount": 3.3, "amount_unit": "mM"},
    {"component_name": "MgCl2", "amount": 3.3, "amount_unit": "mM"},
]
SOLUTION_B = [{"component_name": "glucose-6-phosphate dehydrogenase", "amount": 0.4, "amount_unit": "U/mL"}]


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    reset(engine)
    get_engine.cache_clear()
    with TestClient(app) as test_client:
        yield test_client


def add_lot(client: TestClient, reagent: str, lot_number: str, **fields):
    body = {"reagent_name": reagent, "lot_number": lot_number} | fields
    return client.post("/api/inventory/reagent-lots", json=body, headers=FETCH)


def regenerating_system(client: TestClient) -> tuple[dict, dict]:
    a = add_lot(client, "NADPH regenerating system, Solution A", "RGA-1", reagent_type="regenerating_system", components=SOLUTION_A)
    b = add_lot(client, "NADPH regenerating system, Solution B", "RGB-1", reagent_type="regenerating_system", components=SOLUTION_B)
    assert a.status_code == b.status_code == 201, (a.text, b.text)
    return a.json(), b.json()


def create(client: TestClient, **fields):
    body = {"title": "Components", "study_type": "chemical_inhibition", "substrate": "amodiaquine", "stages": [{"stage_type": "primary"}]}
    return client.post("/api/experiments", json=body | fields, headers=FETCH)


def test_solutions_a_and_b_are_regenerating_systems_with_their_own_components(client: TestClient) -> None:
    a, b = regenerating_system(client)
    assert (a["reagent_type"], b["reagent_type"]) == ("regenerating_system", "regenerating_system")
    assert [c["component_name"] for c in a["components"]] == ["NADP+", "glucose-6-phosphate", "MgCl2"]
    assert [c["component_name"] for c in b["components"]] == ["glucose-6-phosphate dehydrogenase"]
    listed = {row["lot_number"]: row["components"] for row in client.get("/api/inventory/reagent-lots").json()}
    assert listed["RGA-1"] == a["components"] and listed["RGB-1"] == b["components"]


def test_each_lot_of_a_system_records_its_own_components_and_the_lots_they_came_from(client: TestClient) -> None:
    lots = {lot["lot_number"]: lot["id"] for lot in client.get("/api/reference").json()["reagent_lots"]}
    a, _ = regenerating_system(client)
    batch = [{"component_name": "NADP+", "amount": 1.3, "amount_unit": "mM", "component_lot_id": lots["NAD-25610"]}]
    second = add_lot(client, "NADPH regenerating system, Solution A", "RGA-2", components=batch)
    assert second.status_code == 201
    assert second.json()["components"] == [{"component_name": "NADP+", "amount": 1.3, "amount_unit": "mM", "lot_number": "NAD-25610"}]
    listed = {row["lot_number"]: row["components"] for row in client.get("/api/inventory/reagent-lots").json()}
    assert listed["RGA-1"] == a["components"] and all(c["lot_number"] is None for c in listed["RGA-1"])
    assert add_lot(client, "NADPH regenerating system, Solution A", "RGA-3").json()["components"] == []


def test_only_a_regenerating_systems_lots_list_components(client: TestClient) -> None:
    refused = add_lot(client, "NADPH", "N-9", reagent_type="cofactor", components=SOLUTION_B)
    assert refused.status_code == 422 and "only a regenerating system lists components" in refused.text
    untyped = add_lot(client, "alamethicin", "AL-1", components=SOLUTION_B)
    assert untyped.status_code == 422
    assert untyped.json()["detail"] == "alamethicin is not a regenerating system, so its lots list no components."


def test_a_component_keeps_the_role_it_was_given_and_an_unclassified_one_stays_null(client: TestClient) -> None:
    created = create(
        client,
        cofactors=[
            {"cofactor": "NADPH", "role": "cofactor", "concentration": 1, "concentration_unit": "mM"},
            {"cofactor": "DMSO", "role": "solvent", "concentration": 0.1, "concentration_unit": "%"},
            {"cofactor": "alamethicin"},
        ],
    )
    assert created.status_code == 201, created.text
    assert [(c["cofactor"], c["role"]) for c in created.json()["cofactors"]] == [
        ("NADPH", "cofactor"),
        ("DMSO", "solvent"),
        ("alamethicin", None),
    ]


def test_a_role_the_app_does_not_know_is_refused(client: TestClient) -> None:
    refused = create(client, cofactors=[{"cofactor": "NADPH", "role": "enzyme"}])
    assert refused.status_code == 422


def _system_design(client: TestClient, omitted: int | None) -> dict:
    a, b = regenerating_system(client)
    created = create(
        client,
        cofactors=[
            {"cofactor": "NADPH regenerating system, Solution A", "role": "cofactor", "reagent_lot_id": a["id"]},
            {"cofactor": "NADPH regenerating system, Solution B", "role": "cofactor", "reagent_lot_id": b["id"]},
            {"cofactor": "DMSO", "role": "solvent"},
        ],
        controls=[
            {"control_type": "vehicle"},
            {"control_type": "minus_cofactor", **({"omitted_cofactor": omitted} if omitted is not None else {})},
        ],
    )
    assert created.status_code == 201, created.text
    return created.json()


def test_a_control_leaving_out_a_regenerating_system_leaves_out_all_of_its_components(client: TestClient) -> None:
    experiment = _system_design(client, omitted=0)
    control = next(arm for arm in experiment["arms"] if arm["control_type"] == "minus_cofactor")
    assert control["label"] == "Minus NADPH regenerating system, Solution A"
    assert control["omits"] == [
        {"component": "NADPH regenerating system, Solution A", "contains": ["NADP+", "glucose-6-phosphate", "MgCl2"]}
    ]
    system = next(c for c in experiment["cofactors"] if c["cofactor"].endswith("Solution A"))
    assert [c["component_name"] for c in system["components"]] == ["NADP+", "glucose-6-phosphate", "MgCl2"]


def test_leaving_out_every_cofactor_takes_both_solutions_and_never_the_solvent(client: TestClient) -> None:
    experiment = _system_design(client, omitted=None)
    control = next(arm for arm in experiment["arms"] if arm["control_type"] == "minus_cofactor")
    assert control["label"] == "Minus all cofactors"
    assert [item["component"] for item in control["omits"]] == [
        "NADPH regenerating system, Solution A",
        "NADPH regenerating system, Solution B",
    ]
    assert control["omits"][1]["contains"] == ["glucose-6-phosphate dehydrogenase"]


@pytest.mark.parametrize(
    ("role", "message"),
    [("solvent", "leaves out DMSO, which is not listed with the cofactor role"), (None, "leaves out DMSO, which is not listed")],
)
def test_only_a_component_with_the_cofactor_role_can_be_left_out(client: TestClient, role: str | None, message: str) -> None:
    refused = create(
        client,
        cofactors=[{"cofactor": "DMSO", "role": role}],
        controls=[{"control_type": "minus_cofactor", "omitted_cofactor": 0}],
    )
    assert refused.status_code == 422
    assert message in refused.text


def _status(client: TestClient, experiment_id: int, status: str):
    return client.post(f"/api/experiments/{experiment_id}/status", json={"status": status}, headers=FETCH)


def test_completing_an_experiment_warns_about_a_solution_with_no_preparer(client: TestClient) -> None:
    created = create(
        client,
        cofactors=[
            {"cofactor": "NADPH", "role": "cofactor", "solution": {"label": "NADPH 10 mM stock", "prepared_on": "2026-11-09"}},
            {"cofactor": "phosphate buffer", "role": "other", "solution": {"label": "100 mM KPi pH 7.4", "prepared_by": 1}},
        ],
    ).json()
    started = _status(client, created["id"], "in_progress")
    assert started.json() == {"status": "in_progress", "warnings": []}
    completed = _status(client, created["id"], "completed")
    assert completed.status_code == 200
    assert completed.json() == {"status": "completed", "warnings": ["NADPH 10 mM stock names no preparer. Record who prepared it."]}
    detail = client.get(f"/api/experiments/{created['id']}").json()
    assert detail["status"] == "completed"
    solutions = {c["cofactor"]: c["solution"] for c in detail["cofactors"]}
    assert solutions["NADPH"]["prepared_on"] == "2026-11-09" and solutions["NADPH"]["prepared_by"] is None
    members = {member["id"]: member["name"] for member in client.get("/api/reference").json()["members"]}
    assert solutions["phosphate buffer"]["prepared_by"] == members[1]

    recorded = client.patch(
        f"/api/inventory/prepared-solutions/{solutions['NADPH']['id']}", json={"prepared_by": 1}, headers=FETCH
    )
    assert recorded.status_code == 200 and recorded.json()["prepared_by"] == members[1]
    assert recorded.json()["prepared_on"] == "2026-11-09", "fields not sent stay as they were"
    assert _status(client, created["id"], "completed").json() == {"status": "completed", "warnings": []}


def test_a_status_the_app_does_not_know_is_refused(client: TestClient) -> None:
    created = create(client).json()
    assert _status(client, created["id"], "archived").status_code == 422
    assert _status(client, 10**9, "completed").status_code == 404
    assert client.patch("/api/inventory/prepared-solutions/999999", json={"prepared_by": 1}, headers=FETCH).status_code == 404


def test_changing_status_needs_a_signed_in_lab_member(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    created = create(client).json()
    monkeypatch.delenv("DEV_USER_EMAIL")
    assert _status(client, created["id"], "completed").status_code == 401
    monkeypatch.setenv("DEV_USER_EMAIL", "demo@example.org")
    assert client.get(f"/api/experiments/{created['id']}").json()["status"] == "planned"


def test_a_prepared_solution_can_be_cited_again_by_a_later_experiment(client: TestClient) -> None:
    first = create(client, cofactors=[{"cofactor": "NADPH", "role": "cofactor", "solution": {"label": "NADPH stock A", "prepared_by": 1}}])
    solution = first.json()["cofactors"][0]["solution"]
    listed = client.get("/api/reference").json()["prepared_solutions"]
    assert solution in listed
    second = create(client, cofactors=[{"cofactor": "NADPH", "role": "cofactor", "prepared_solution_id": solution["id"]}])
    assert second.status_code == 201
    assert second.json()["cofactors"][0]["solution"] == solution
    both = create(
        client,
        cofactors=[{"cofactor": "NADPH", "role": "cofactor", "prepared_solution_id": solution["id"], "solution": {"label": "x"}}],
    )
    assert both.status_code == 422


def _experiment(session: Session) -> Experiment:
    experiment = Experiment(study_type="substrate_depletion", title="component check")
    session.add(experiment)
    session.flush()
    return experiment


@pytest.mark.parametrize(
    ("constraint", "make"),
    [
        ("ck_experiment_cofactor_role", lambda s: ExperimentCofactor(experiment_id=_experiment(s).id, cofactor="NADPH", component_role="enzyme")),
        ("ck_reagent_type", lambda s: Reagent(name="mystery", reagent_type="mystery")),
        ("ck_prepared_solution_label", lambda s: PreparedSolution(label="  ")),
        ("ck_reagent_component_unit", lambda s: ReagentComponent(reagent_lot_id=_system_lot(s), component_name="NADP+", amount=1)),
        (
            "ck_reagent_component_amount",
            lambda s: ReagentComponent(reagent_lot_id=_system_lot(s), component_name="NADP+", amount=-1, amount_unit="mM"),
        ),
        ("ck_reagent_component_name", lambda s: ReagentComponent(reagent_lot_id=_system_lot(s), component_name=" ")),
        (
            "ck_reagent_component_not_itself",
            lambda s: ReagentComponent(reagent_lot_id=(lot := _system_lot(s)), component_name="NADP+", component_lot_id=lot),
        ),
    ],
)
def test_the_database_refuses_each_bad_component_row(session: Session, constraint: str, make) -> None:
    with pytest.raises(IntegrityError) as refused:
        session.add(make(session))
        session.flush()
    assert refused.value.orig.diag.constraint_name == constraint
    assert constraint in CONSTRAINT_MESSAGES


def _system_lot(session: Session) -> int:
    reagent = Reagent(name="NADPH regenerating system, Solution A", reagent_type="regenerating_system")
    session.add(reagent)
    session.flush()
    lot = ReagentLot(reagent_id=reagent.id, lot_number="RGA-T")
    session.add(lot)
    session.flush()
    return lot.id
