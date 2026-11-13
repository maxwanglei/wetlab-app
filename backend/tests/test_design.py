import pytest

from app.science.design import ArmSpec, ControlSpec, comparable_concentration, control_label, resolve_reference, unique

STAGE = 1


def control(id: int, control_type: str, label: str, solvent: str | None = None, percentage: float | None = None, omitted: int | None = None, stage: int = STAGE) -> ControlSpec:
    return ControlSpec(id, stage, control_type, label, solvent, percentage, omitted)


def arm(solvent: str | None = None, percentage: float | None = None, *, omitted: bool = False, omitted_id: int | None = None, explicit: int | None = None, stage: int = STAGE) -> ArmSpec:
    return ArmSpec("ketoconazole", stage, solvent, percentage, omitted, omitted_id, explicit)


def test_the_only_vehicle_is_the_reference() -> None:
    found = resolve_reference(arm(), [control(1, "vehicle", "Vehicle control")], "DMSO", "primary")
    assert (found.control_id, found.source, found.problem, found.check) == (1, "matched", None, None)


@pytest.mark.parametrize(("solvent", "expected"), [("DMSO", 1), ("acetonitrile", 2), ("none", 3)])
def test_each_arm_is_compared_against_the_control_in_its_own_solvent(solvent: str, expected: int) -> None:
    controls = [
        control(1, "vehicle", "Vehicle control (DMSO)", "DMSO"),
        control(2, "vehicle", "Vehicle control (acetonitrile)", "acetonitrile"),
        control(3, "complete", "Complete incubation"),
        control(4, "minus_cofactor", "Minus NADPH"),
    ]
    found = resolve_reference(arm(solvent), controls, "DMSO", "primary")
    assert (found.control_id, found.source) == (expected, "matched")


def test_an_arm_without_its_own_solvent_inherits_the_experiments() -> None:
    controls = [control(1, "vehicle", "Vehicle control (DMSO)", "DMSO"), control(2, "vehicle", "Vehicle control (ACN)", "acetonitrile")]
    assert resolve_reference(arm(None), controls, "dmso", "primary").control_id == 1


def test_one_solvent_at_two_percentages_is_narrowed_by_percentage() -> None:
    controls = [control(1, "vehicle", "DMSO 0.1%", "DMSO", 0.1), control(2, "vehicle", "DMSO 0.5%", "DMSO", 0.5)]
    assert resolve_reference(arm("DMSO", 0.5), controls, None, "primary").control_id == 2


def test_two_matching_references_are_a_problem_not_a_guess() -> None:
    controls = [control(1, "vehicle", "Vehicle A", "DMSO"), control(2, "vehicle", "Vehicle B", "DMSO")]
    found = resolve_reference(arm("DMSO"), controls, None, "primary")
    assert found.control_id is None
    assert found.problem == "ketoconazole: 2 reference controls match in the primary stage; choose one on the arm"


def test_the_stages_only_reference_is_used_with_a_check_when_no_solvent_matches() -> None:
    found = resolve_reference(arm("methanol"), [control(1, "vehicle", "Vehicle control", "DMSO")], None, "primary")
    assert (found.control_id, found.source) == (1, "fallback")
    assert found.check == "ketoconazole: no reference control in methanol; compared against Vehicle control"


def test_no_match_among_several_references_is_a_problem() -> None:
    controls = [control(1, "vehicle", "Vehicle (DMSO)", "DMSO"), control(2, "vehicle", "Vehicle (ACN)", "acetonitrile")]
    found = resolve_reference(arm("methanol"), controls, None, "secondary")
    assert found.control_id is None and "no reference control in the secondary stage matches its solvent" in found.problem


def test_an_explicit_reference_wins() -> None:
    controls = [control(1, "vehicle", "Vehicle", "DMSO"), control(2, "vehicle", "Other vehicle", "DMSO")]
    assert resolve_reference(arm("DMSO", explicit=2), controls, None, "primary") == resolve_reference(arm(explicit=2), [], None, "primary")
    assert resolve_reference(arm("DMSO", explicit=2), controls, None, "primary").control_id == 2


def test_a_cofactor_omitted_arm_is_compared_against_the_control_omitting_the_same_cofactor() -> None:
    controls = [
        control(1, "vehicle", "Vehicle control"),
        control(2, "minus_cofactor", "Minus NADPH", omitted=10),
        control(3, "minus_cofactor", "Minus UDPGA", omitted=11),
    ]
    assert resolve_reference(arm(omitted=True, omitted_id=10), controls, None, "primary").control_id == 2
    assert resolve_reference(arm(omitted=True, omitted_id=11), controls, None, "primary").control_id == 3


@pytest.mark.parametrize(("minutes", "expected"), [(30, 1), (5, 2)])
def test_two_vehicles_in_one_solvent_are_told_apart_by_their_time_in_the_stage(minutes: float, expected: int) -> None:
    controls = [
        ControlSpec(1, STAGE, "vehicle", "Vehicle, gem-gluc set", "DMSO", 0.5, None, 30),
        ControlSpec(2, STAGE, "vehicle", "Vehicle, CYP3cide set", "DMSO", 0.5, None, 5),
        ControlSpec(3, STAGE, "minus_cofactor", "Minus NADPH, gem-gluc set", "DMSO", 0.5, 10, 30),
        ControlSpec(4, STAGE, "minus_cofactor", "Minus NADPH, CYP3cide set", "DMSO", 0.5, 10, 5),
    ]
    found = resolve_reference(ArmSpec("inhibitor", STAGE, "DMSO", 0.5, False, None, None, minutes), controls, None, "primary")
    assert (found.control_id, found.source) == (expected, "matched")
    twin = resolve_reference(ArmSpec("inhibitor minus NADPH", STAGE, "DMSO", 0.5, True, 10, None, minutes), controls, None, "primary")
    assert twin.control_id == expected + 2


def test_a_time_no_vehicle_shares_leaves_the_choice_open() -> None:
    controls = [
        ControlSpec(1, STAGE, "vehicle", "Vehicle A", "DMSO", None, None, 30),
        ControlSpec(2, STAGE, "vehicle", "Vehicle B", "DMSO", None, None, 5),
    ]
    found = resolve_reference(ArmSpec("ketoconazole", STAGE, "DMSO", None, False, None, None, 10), controls, None, "primary")
    assert found.control_id is None
    assert found.problem == "ketoconazole: 2 reference controls match in the primary stage; choose one on the arm"


def test_references_in_another_stage_are_never_used() -> None:
    found = resolve_reference(arm(stage=2), [control(1, "vehicle", "Vehicle control", stage=1)], None, "secondary")
    assert found.control_id is None
    assert found.problem == "ketoconazole: no reference control in the secondary stage, so no % inhibition"


def test_a_twin_without_a_control_leaving_out_its_cofactor_is_a_problem() -> None:
    found = resolve_reference(arm(omitted=True, omitted_id=10), [control(1, "vehicle", "Vehicle control")], None, "primary")
    assert found.problem == "ketoconazole: no control in the primary stage leaves out the same cofactor, so no % inhibition"


def test_a_lone_same_solvent_reference_at_another_percentage_is_used_with_a_check() -> None:
    found = resolve_reference(arm("DMSO", 0.5), [control(1, "vehicle", "Vehicle control", "DMSO", 0.1)], None, "primary")
    assert (found.control_id, found.source) == (1, "matched")
    assert found.check == "ketoconazole: 0.5% DMSO, compared against Vehicle control at 0.1%"


@pytest.mark.parametrize(
    ("value", "unit", "micromolar"),
    [(100, "nM", 0.1), (10, "uM", 10), (1, "mM", 1000), (5, "ug/mL", 5), (None, "uM", None)],
)
def test_molar_concentrations_compare_in_micromolar(value, unit, micromolar) -> None:
    assert comparable_concentration(value, unit) == pytest.approx(micromolar) if micromolar is not None else comparable_concentration(value, unit) is None


@pytest.mark.parametrize(
    ("control_type", "fields", "expected"),
    [
        ("vehicle", {}, "Vehicle control"),
        ("vehicle", {"solvent": "acetonitrile", "solvent_percentage": 0.5, "name_solvent": True}, "Vehicle control (acetonitrile 0.5%)"),
        ("complete", {}, "Complete incubation"),
        ("minus_cofactor", {"omitted_cofactor": "UDPGA"}, "Minus UDPGA"),
        ("minus_cofactor", {"any_cofactors": True}, "Minus all cofactors"),
        ("minus_cofactor", {}, "Minus cofactor"),
        ("minus_protein", {}, "Minus protein"),
        ("minus_protein", {"hepatocytes": True}, "No cells"),
        ("heat_inactivated", {"protein": 0.1}, "Heat-inactivated 0.1 mg/mL"),
        ("minus_substrate", {}, "Minus substrate"),
    ],
)
def test_a_control_without_a_label_gets_one_from_its_type(control_type: str, fields: dict, expected: str) -> None:
    base = {
        "solvent": None,
        "solvent_percentage": None,
        "omitted_cofactor": None,
        "any_cofactors": False,
        "protein": None,
        "hepatocytes": False,
        "name_solvent": False,
    }
    assert control_label(control_type, **(base | fields)) == expected


def test_an_other_control_needs_a_label() -> None:
    with pytest.raises(ValueError):
        control_label(
            "other", solvent=None, solvent_percentage=None, omitted_cofactor=None, any_cofactors=False, protein=None, hepatocytes=False, name_solvent=False
        )


def test_repeated_labels_are_numbered_in_order() -> None:
    assert unique(["Minus NADPH", "Vehicle control", "minus nadph", "Minus NADPH"]) == ["Minus NADPH", "Vehicle control", "minus nadph 2", "Minus NADPH 3"]
