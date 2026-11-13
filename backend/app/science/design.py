"""How an experiment's conditions relate: which control each arm is compared against, and what each
condition is called. Pure functions over plain data; no database or web types."""

import math
from collections import Counter
from dataclasses import dataclass
from typing import Literal

REFERENCE_TYPES = ("vehicle", "complete")
NEGATIVE_MIN_PERCENT_REMAINING = 80.0


@dataclass(frozen=True)
class ControlSpec:
    id: int
    stage_id: int
    control_type: str
    label: str
    solvent: str | None
    solvent_percentage: float | None
    omitted_cofactor_id: int | None
    minutes: float | None = None


@dataclass(frozen=True)
class ArmSpec:
    label: str
    stage_id: int
    solvent: str | None
    solvent_percentage: float | None
    cofactor_omitted: bool
    omitted_cofactor_id: int | None
    reference_control_id: int | None
    minutes: float | None = None


@dataclass(frozen=True)
class Resolution:
    control_id: int | None
    source: Literal["explicit", "matched", "fallback"] | None
    problem: str | None = None
    check: str | None = None


def effective_solvent(control_type: str | None, solvent: str | None, condition_solvent: str | None) -> str:
    """The solvent a condition carries: 'none' for a complete incubation or an aqueous arm, its own when
    set, else the experiment's."""
    if control_type == "complete":
        return "none"
    return (solvent or condition_solvent or "").strip().lower()


def _same_minutes(a: float | None, b: float | None) -> bool:
    return a == b or (a is not None and b is not None and math.isclose(a, b))


def resolve_reference(
    arm: ArmSpec,
    controls: list[ControlSpec],
    condition_solvent: str | None,
    stage_name: str,
    *,
    remedy: str = "choose one on the arm",
) -> Resolution:
    """The control an arm is compared against. An explicit choice wins. Otherwise the one eligible control
    in the arm's stage with the same solvent, narrowed by percentage when both give one, then by time in the
    stage. Otherwise the stage's only eligible control, with a check line. Never the first control by accident."""
    if arm.reference_control_id is not None:
        return Resolution(arm.reference_control_id, "explicit")
    if arm.cofactor_omitted:
        eligible = [
            c for c in controls
            if c.stage_id == arm.stage_id and c.control_type == "minus_cofactor" and c.omitted_cofactor_id == arm.omitted_cofactor_id
        ]
    else:
        eligible = [c for c in controls if c.stage_id == arm.stage_id and c.control_type in REFERENCE_TYPES]
    if not eligible:
        missing = "no control in the {} stage leaves out the same cofactor" if arm.cofactor_omitted else "no reference control in the {} stage"
        return Resolution(None, None, problem=f"{arm.label}: {missing.format(stage_name)}, so no % inhibition")
    solvent = effective_solvent(None, arm.solvent, condition_solvent)
    shown = (arm.solvent or condition_solvent or "").strip() or solvent
    matched = [c for c in eligible if effective_solvent(c.control_type, c.solvent, condition_solvent) == solvent]
    if len(matched) > 1 and arm.solvent_percentage is not None:
        narrowed = [
            c for c in matched if c.solvent_percentage is not None and math.isclose(c.solvent_percentage, arm.solvent_percentage)
        ]
        matched = narrowed or matched
    if len(matched) > 1:
        timed = [c for c in matched if _same_minutes(c.minutes, arm.minutes)]
        matched = timed or matched
    if len(matched) == 1:
        found = matched[0]
        if (
            arm.solvent_percentage is not None
            and found.solvent_percentage is not None
            and not math.isclose(found.solvent_percentage, arm.solvent_percentage)
        ):
            return Resolution(
                found.id,
                "matched",
                check=f"{arm.label}: {arm.solvent_percentage:g}% {shown}, compared against {found.label} at {found.solvent_percentage:g}%",
            )
        return Resolution(found.id, "matched")
    if len(matched) > 1:
        return Resolution(
            None, None, problem=f"{arm.label}: {len(matched)} reference controls match in the {stage_name} stage; {remedy}"
        )
    if len(eligible) == 1:
        return Resolution(
            eligible[0].id,
            "fallback",
            check=f"{arm.label}: no reference control in {shown or 'its solvent'}; compared against {eligible[0].label}",
        )
    return Resolution(
        None, None, problem=f"{arm.label}: no reference control in the {stage_name} stage matches its solvent; {remedy}"
    )


MICROMOLAR_PER_UNIT = {"M": 1e6, "mM": 1e3, "uM": 1.0, "µM": 1.0, "nM": 1e-3, "pM": 1e-6}


def comparable_concentration(value: float | None, unit: str | None) -> float | None:
    """A concentration in µM when its unit is molar, so 100 nM ranks below 10 µM; otherwise as entered."""
    if value is None:
        return None
    factor = MICROMOLAR_PER_UNIT.get((unit or "").strip())
    return value * factor if factor is not None else value


def control_label(
    control_type: str,
    *,
    solvent: str | None,
    solvent_percentage: float | None,
    omitted_cofactor: str | None,
    any_cofactors: bool,
    protein: float | None,
    hepatocytes: bool,
    name_solvent: bool,
) -> str:
    """The label a control gets when its request names none. name_solvent is set when its stage holds
    another control of the same type in a different solvent."""
    base = {
        "vehicle": "Vehicle control",
        "complete": "Complete incubation",
        "minus_substrate": "Minus substrate",
        "minus_protein": "No cells" if hepatocytes else "Minus protein",
        "heat_inactivated": "Heat-inactivated",
    }.get(control_type)
    if control_type == "minus_cofactor":
        base = f"Minus {omitted_cofactor}" if omitted_cofactor else ("Minus all cofactors" if any_cofactors else "Minus cofactor")
    if base is None:
        raise ValueError(f"a {control_type} control needs a label")
    if control_type == "heat_inactivated" and protein is not None:
        base = f"{base} {protein:g} mg/mL"
    if name_solvent and solvent:
        percentage = f" {solvent_percentage:g}%" if solvent_percentage is not None else ""
        base = f"{base} ({solvent}{percentage})"
    return base


def unique(labels: list[str]) -> list[str]:
    """Each label once, case-insensitively, by numbering repeats in order: 'Vehicle control 2'."""
    seen: Counter[str] = Counter()
    out = []
    for label in labels:
        seen[label.lower()] += 1
        candidate = label if seen[label.lower()] == 1 else f"{label} {seen[label.lower()]}"
        while candidate.lower() in {existing.lower() for existing in out}:
            seen[label.lower()] += 1
            candidate = f"{label} {seen[label.lower()]}"
        out.append(candidate)
    return out
