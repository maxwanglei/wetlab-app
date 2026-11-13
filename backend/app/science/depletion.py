"""Substrate-depletion analysis for one experiment: a pooled ln-linear fit per arm (free
intercept), CLint, % inhibition with a delta-method SE, and apparent fm from chemical
inhibition. Pure functions over plain data; no database or web types."""

import math
from dataclasses import dataclass, replace
from typing import Literal

import numpy as np
from scipy import stats

from app.science.design import NEGATIVE_MIN_PERCENT_REMAINING

Z95 = 1.959963984540054
MIN_TIMEPOINTS = 3

METHOD = (
    "Pooled ln-linear least squares per arm with a free intercept. "
    "CLint,app = k x 1000 / protein (mg/mL). "
    "% inhibition = 100 x (1 - k_inhibited / k_control), SE by the delta method, "
    "n.s. when the 95% CI includes 0. "
    "Apparent fm = % inhibition / 100 for the inhibitor's target enzyme, "
    "assuming complete and selective inhibition."
)
NEGATIVE_METHOD = (
    f" A negative control gets no CLint; it passes with at least {NEGATIVE_MIN_PERCENT_REMAINING:g}% parent remaining "
    "at its last timepoint, or no measurable loss."
)

Role = Literal["reference", "test", "negative"]


@dataclass(frozen=True)
class Point:
    measurement_id: int
    replicate: int
    time_min: float
    percent_remaining: float
    excluded: bool


@dataclass(frozen=True)
class Arm:
    modulator_id: int | None  # with no role given, None is the vehicle control arm
    label: str
    target_enzyme: str | None
    points: tuple[Point, ...]
    key: str = ""
    role: Role | None = None
    reference_key: str | None = None
    group_key: str | None = None
    concentration: float | None = None
    cofactor_omitted: bool = False
    # A negative control is judged only while its omission is still in force where it was sampled.
    judge: bool = True
    target_enzymes: tuple[str, ...] = ()


@dataclass(frozen=True)
class ArmFit:
    modulator_id: int | None
    label: str
    n_points: int
    n_excluded: int
    n_replicates: int
    k: float | None = None
    k_se: float | None = None
    half_life_min: float | None = None
    half_life_extrapolated: bool = False
    clint_app: float | None = None
    clint_app_sd: float | None = None
    clint_u: float | None = None
    r_squared: float | None = None
    t0_backextrapolated: float | None = None
    window_min: tuple[float, float] | None = None
    fit_line: tuple[tuple[float, float], ...] = ()
    problem: str | None = None
    key: str = ""


@dataclass(frozen=True)
class Inhibition:
    modulator_id: int
    label: str
    target_enzyme: str | None
    percent: float
    se: float
    significant: bool
    fm_apparent: float | None
    key: str = ""
    group_key: str | None = None
    concentration: float | None = None
    cofactor_omitted: bool = False
    fm_counted: bool = False
    fm_note: str | None = None


@dataclass(frozen=True)
class NegativeCheck:
    key: str
    percent_remaining_last: float | None
    last_time_min: float | None
    n_at_last: int
    k_ratio: float | None
    k_ratio_se: float | None
    verdict: Literal["pass", "flag", "not_judged"]
    reason: str | None


@dataclass(frozen=True)
class CofactorCorrection:
    key: str
    twin_key: str
    remaining_activity: float
    se: float | None


@dataclass(frozen=True)
class DepletionAnalysis:
    fits: tuple[ArmFit, ...]
    inhibitions: tuple[Inhibition, ...]
    fm_total: float | None
    fm_unassigned: float | None
    problems: tuple[str, ...]
    method: str = METHOD
    negatives: tuple[NegativeCheck, ...] = ()
    corrections: tuple[CofactorCorrection, ...] = ()
    checks: tuple[str, ...] = ()


# The line an experiment whose arms have no reference with data gets, worded as before controls were rows.
NO_REFERENCE = "no vehicle control arm, so no % inhibition or fm"


def _clint(k: float, protein_mg_per_ml: float | None) -> float | None:
    if protein_mg_per_ml is None or protein_mg_per_ml <= 0:
        return None
    return k * 1000 / protein_mg_per_ml


def _replicate_clints(used: list[Point], protein_mg_per_ml: float | None) -> list[float]:
    clints = []
    for replicate in sorted({p.replicate for p in used}):
        points = [p for p in used if p.replicate == replicate]
        if len({p.time_min for p in points}) < MIN_TIMEPOINTS:
            continue
        fit = stats.linregress([p.time_min for p in points], np.log([p.percent_remaining for p in points]))
        clint = _clint(-fit.slope, protein_mg_per_ml)
        if clint is not None:
            clints.append(clint)
    return clints


def _used(arm: Arm) -> list[Point]:
    return [p for p in arm.points if not p.excluded and p.percent_remaining > 0]


def _counts(arm: Arm, used: list[Point]) -> dict:
    return {
        "modulator_id": arm.modulator_id,
        "label": arm.label,
        "key": arm.key,
        "n_points": len(used),
        "n_excluded": sum(p.excluded for p in arm.points),
        "n_replicates": len({p.replicate for p in used}),
    }


def _line(used: list[Point]) -> dict:
    t = np.array([p.time_min for p in used], dtype=float)
    fit = stats.linregress(t, np.log([p.percent_remaining for p in used]))
    window = (float(t.min()), float(t.max()))
    return {
        "k": float(-fit.slope),
        "k_se": float(fit.stderr),
        "r_squared": float(fit.rvalue**2),
        "t0_backextrapolated": math.exp(fit.intercept),
        "window_min": window,
        "fit_line": tuple((x, math.exp(fit.intercept + fit.slope * x)) for x in window),
    }


def fit_negative(arm: Arm) -> ArmFit:
    """A negative control's slope, for comparison with its reference; never a CLint or a problem."""
    used = _used(arm)
    counts = _counts(arm, used)
    if len({p.time_min for p in used}) < MIN_TIMEPOINTS:
        return ArmFit(**counts)
    return ArmFit(**counts, **_line(used))


def fit_arm(arm: Arm, protein_mg_per_ml: float | None, fu_inc: float | None) -> ArmFit:
    used = _used(arm)
    counts = _counts(arm, used)
    if len({p.time_min for p in used}) < MIN_TIMEPOINTS:
        return ArmFit(**counts, problem=f"fewer than {MIN_TIMEPOINTS} usable timepoints")

    shared = _line(used)
    k = shared["k"]
    window = shared["window_min"]
    if k <= 0:
        return ArmFit(**counts, **shared, problem="no measurable depletion")

    half_life = math.log(2) / k
    clint = _clint(k, protein_mg_per_ml)
    replicate_clints = _replicate_clints(used, protein_mg_per_ml)
    return ArmFit(
        **counts,
        **shared,
        half_life_min=half_life,
        half_life_extrapolated=half_life > window[1],
        clint_app=clint,
        clint_app_sd=float(np.std(replicate_clints, ddof=1)) if len(replicate_clints) > 1 else None,
        clint_u=clint / fu_inc if clint is not None and fu_inc else None,
        problem=None if clint is not None else (
            "protein concentration missing, so no CLint" if protein_mg_per_ml is None
            else "protein concentration must be positive, so no CLint"
        ),
    )


def inhibition(control: ArmFit, arm: Arm, fit: ArmFit) -> Inhibition | None:
    if arm.modulator_id is None or fit.k is None or control.k is None:
        return None
    ratio = fit.k / control.k
    percent = 100 * (1 - ratio)
    se = 100 * math.sqrt(fit.k_se**2 + ratio**2 * control.k_se**2) / control.k
    significant = abs(percent) > Z95 * se
    multiple_targets = len(arm.target_enzymes) > 1
    return Inhibition(
        modulator_id=arm.modulator_id,
        label=arm.label,
        target_enzyme=arm.target_enzyme,
        percent=percent,
        se=se,
        significant=significant,
        fm_apparent=min(percent / 100, 1.0) if significant and percent > 0 and not multiple_targets else None,
        key=arm.key,
        group_key=arm.group_key,
        concentration=arm.concentration,
        cofactor_omitted=arm.cofactor_omitted,
        fm_note=f"targets {', '.join(arm.target_enzymes)}; their individual fm cannot be determined from this inhibition"
        if multiple_targets else None,
    )


def _with_roles(arms: list[Arm]) -> list[Arm]:
    """Arms built before roles existed: the first arm without a modulator is every other arm's reference."""
    keyed = [arm if arm.key else replace(arm, key=f"#{index}") for index, arm in enumerate(arms)]
    if any(arm.role is not None for arm in keyed):
        return keyed
    reference = next((arm.key for arm in keyed if arm.modulator_id is None), None)
    return [
        replace(arm, role="reference") if arm.modulator_id is None else replace(arm, role="test", reference_key=reference)
        for arm in keyed
    ]


def _rate_ratio(fit: ArmFit, reference: ArmFit | None) -> tuple[float | None, float | None]:
    """A negative's rate over its reference's, with a delta-method SE. A flat or rising negative gives a ratio at or
    below zero, which is its expected result, so only the reference's rate must be positive."""
    if reference is None or fit.k is None or reference.k is None or reference.k <= 0:
        return None, None
    ratio = fit.k / reference.k
    return ratio, math.sqrt(fit.k_se**2 + ratio**2 * reference.k_se**2) / reference.k


def negative_check(arm: Arm, fit: ArmFit, reference: ArmFit | None) -> NegativeCheck:
    """How much parent a negative keeps at its last timepoint. A negative read after its omission ended, in a later
    stage, keeps its numbers as a baseline but gets no verdict."""
    ratio, ratio_se = _rate_ratio(fit, reference)
    used = _used(arm)
    later = [p.time_min for p in used if p.time_min > 0]
    if not later:
        return NegativeCheck(arm.key, None, None, 0, ratio, ratio_se, "not_judged", "no timepoint after T0")
    last = max(later)
    at_last = [p.percent_remaining for p in used if p.time_min == last]
    mean = sum(at_last) / len(at_last)
    if not arm.judge:
        return NegativeCheck(
            arm.key, mean, last, len(at_last), ratio, ratio_se, "not_judged", "omission ends before the sampled stage; used as baseline"
        )
    passed = mean >= NEGATIVE_MIN_PERCENT_REMAINING or (fit.k is not None and fit.k <= 0)
    return NegativeCheck(arm.key, mean, last, len(at_last), ratio, ratio_se, "pass" if passed else "flag", None)


def shown_percent(value: float) -> str:
    """A percent remaining as a check line shows it: cut, not rounded, to one decimal, so a value under the
    threshold never reads as the threshold itself."""
    return f"{math.floor(value * 10) / 10:g}"


def _count_fm(inhibitions: list[Inhibition]) -> list[Inhibition]:
    """Count each enzyme once: the highest concentration of each group, then the largest fm per enzyme.
    An arm run without its cofactor never counts."""
    candidates = [i for i in inhibitions if not i.cofactor_omitted]
    best_in_group: dict[str, Inhibition] = {}
    for item in candidates:
        group = item.group_key or item.key
        held = best_in_group.get(group)
        if held is None or (item.concentration or 0) > (held.concentration or 0) or (
            (item.concentration or 0) == (held.concentration or 0) and item.modulator_id < held.modulator_id
        ):
            best_in_group[group] = item
    counted: dict[str, Inhibition] = {}
    for group, item in best_in_group.items():
        if item.fm_apparent is None:
            continue
        enzyme = item.target_enzyme or f"group {group}"
        held = counted.get(enzyme)
        if held is None or item.fm_apparent > held.fm_apparent or (
            item.fm_apparent == held.fm_apparent and item.modulator_id < held.modulator_id
        ):
            counted[enzyme] = item
    winners = {item.key: enzyme for enzyme, item in counted.items()}
    out = []
    for item in inhibitions:
        if item.key in winners:
            out.append(replace(item, fm_counted=True))
        elif item.fm_apparent is None:
            out.append(item)
        elif item.cofactor_omitted:
            out.append(replace(item, fm_note="run without its cofactor, so not counted"))
        else:
            winner = counted.get(item.target_enzyme or f"group {item.group_key or item.key}")
            highest = best_in_group.get(item.group_key or item.key)
            if winner is not None:
                note = f"{item.target_enzyme or 'this group'} counted by {winner.label}"
            elif highest is not None:
                note = f"highest concentration {highest.label} has no attributable fm, so this series is not counted"
            else:
                note = "not counted"
            out.append(replace(item, fm_note=note))
    return out


def _corrections(arms: list[Arm], fits: dict[str, ArmFit]) -> tuple[tuple[CofactorCorrection, ...], tuple[str, ...]]:
    """For an arm with a cofactor-omitted twin at the same concentration, the activity remaining once
    the cofactor-independent part is divided out. Display only."""
    out = []
    checks = []
    for present in (a for a in arms if a.role == "test" and not a.cofactor_omitted):
        twins = [
            a for a in arms
            if a.role == "test" and a.cofactor_omitted and a.group_key == present.group_key and a.concentration == present.concentration
        ]
        if not twins:
            continue
        if len(twins) > 1:
            labels = "; ".join(sorted(a.label for a in twins))
            checks.append(f"{present.label}: cofactor correction withheld because more than one run without cofactor matches ({labels})")
            continue
        (twin,) = twins
        rates = [fits.get(present.key), fits.get(present.reference_key or ""), fits.get(twin.key), fits.get(twin.reference_key or "")]
        if any(f is None or f.k is None or f.k <= 0 for f in rates):
            continue
        k_present, k_present_ref, k_twin, k_twin_ref = (f.k for f in rates)
        value = (k_present / k_present_ref) / (k_twin / k_twin_ref)
        relative = math.sqrt(sum((f.k_se / f.k) ** 2 for f in rates))
        out.append(CofactorCorrection(present.key, twin.key, value, value * relative))
    return tuple(out), tuple(checks)


def analyze(arms: list[Arm], protein_mg_per_ml: float | None, fu_inc: float | None) -> DepletionAnalysis:
    arms = _with_roles(arms)
    fits = [fit_negative(arm) if arm.role == "negative" else fit_arm(arm, protein_mg_per_ml, fu_inc) for arm in arms]
    by_key = {fit.key: fit for fit in fits}
    # A run without its cofactor is expected to lose little parent, so a flat fit there is no problem.
    problems = [
        f"{fit.label}: {fit.problem}"
        for arm, fit in zip(arms, fits, strict=True)
        if fit.problem and arm.role != "negative" and not (arm.cofactor_omitted and fit.k is not None and fit.k <= 0)
    ]
    references = [arm for arm in arms if arm.role == "reference"]
    tests = [arm for arm in arms if arm.role == "test"]

    inhibitions: list[Inhibition] = []
    if tests and not references:
        problems.append(NO_REFERENCE)
    unusable: dict[str, str] = {}
    twin_checks: list[str] = []
    for arm in tests:
        reference = by_key.get(arm.reference_key) if arm.reference_key else None
        if reference is None:
            continue
        if reference.k is None or reference.k <= 0:
            if arm.cofactor_omitted:
                why = "shows no loss" if reference.k is not None else "has no usable rate"
                twin_checks.append(f"{arm.label}: {reference.label} {why}, so this run without cofactor has no rate to compare with")
            else:
                unusable[reference.key] = reference.label
            continue
        result = inhibition(reference, arm, by_key[arm.key])
        if result is not None:
            inhibitions.append(result)
    for label in unusable.values():
        prefix = f"{label}: " if len(references) > 1 else ""
        problems.append(f"{prefix}the control arm has no usable depletion rate, so no % inhibition or fm")

    inhibitions = _count_fm(inhibitions)
    counted = [i.fm_apparent for i in inhibitions if i.fm_counted]
    fm_total = sum(counted) if counted else None
    negatives = tuple(
        negative_check(arm, by_key[arm.key], by_key.get(arm.reference_key) if arm.reference_key else None)
        for arm in arms
        if arm.role == "negative"
    )
    corrections, correction_checks = _corrections(arms, by_key)
    checks = tuple(
        f"{by_key[n.key].label}: {shown_percent(n.percent_remaining_last)}% remaining at {n.last_time_min:g} min "
        f"(threshold {NEGATIVE_MIN_PERCENT_REMAINING:g}%)"
        for n in negatives
        if n.verdict == "flag"
    ) + tuple(twin_checks) + correction_checks
    return DepletionAnalysis(
        fits=tuple(fits),
        inhibitions=tuple(inhibitions),
        fm_total=fm_total,
        fm_unassigned=1 - fm_total if fm_total is not None else None,
        problems=tuple(problems),
        method=METHOD + NEGATIVE_METHOD if negatives else METHOD,
        negatives=negatives,
        corrections=corrections,
        checks=checks,
    )
