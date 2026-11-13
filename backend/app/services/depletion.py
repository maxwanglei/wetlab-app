"""Bridge between the database and app.science.depletion: load an experiment's points, run the
analysis, and save exclusions plus per-arm results."""

import math

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.models import AssayMeasurement, ExperimentCondition, LabMember, SubstrateDepletionResult
from app.schemas import (
    ArmInfo,
    ArmResult,
    CofactorCorrectionOut,
    DepletionResult,
    Exclusion,
    FitOut,
    InhibitionOut,
    NegativeCheckOut,
    PointOut,
    SavedRun,
)
from app.science.depletion import Z95, Arm, DepletionAnalysis, Point, analyze
from app.science.design import NEGATIVE_MIN_PERCENT_REMAINING, comparable_concentration
from app.services import stages
from app.services.experiments import arms, get_experiment, parent_arms

VALUE_UNIT = "uL/min/mg protein"
NEGATIVE_UNIT = "% of T0 at last timepoint"
ROLES = {"control": "reference", "negative_control": "negative"}


def _measurements(session: Session, experiment_id: int) -> list[AssayMeasurement]:
    return list(
        session.scalars(
            select(AssayMeasurement)
            .where(
                AssayMeasurement.experiment_id == experiment_id,
                AssayMeasurement.measured_entity == "parent_remaining",
                AssayMeasurement.normalized_value.is_not(None),
            )
            .order_by(AssayMeasurement.replicate_number, AssayMeasurement.timepoint, AssayMeasurement.id)
        )
    )


def legacy_control_key(infos: list[ArmInfo]) -> str | None:
    """Where a point with no arm and no control belongs: an older build wrote it, and to that build it
    meant the vehicle control, which is now the primary stage's first reference control."""
    return next((info.key for info in infos if info.kind == "control" and info.stage == "primary"), None)


def _arm_key(row: AssayMeasurement, unassigned: str | None) -> str | None:
    if row.experiment_control_id is not None:
        return f"ctl-{row.experiment_control_id}"
    if row.experiment_modulator_id is not None:
        return f"arm-{row.experiment_modulator_id}"
    return unassigned


def _saved_run(session: Session, experiment_id: int) -> SavedRun | None:
    row = session.execute(
        select(SubstrateDepletionResult.computed_at, LabMember.full_name)
        .outerjoin(LabMember, LabMember.id == SubstrateDepletionResult.computed_by)
        .where(SubstrateDepletionResult.experiment_id == experiment_id)
        .order_by(SubstrateDepletionResult.computed_at.desc())
        .limit(1)
    ).first()
    return SavedRun(computed_at=row[0], computed_by=row[1]) if row else None


def _analysis(
    session: Session, experiment_id: int, excluded_ids: set[int] | None
) -> tuple[DepletionResult, DepletionAnalysis, list[ArmInfo]]:
    experiment = get_experiment(session, experiment_id)
    arm_infos = parent_arms(arms(session, experiment))
    unassigned = legacy_control_key(arm_infos)
    rows = _measurements(session, experiment_id)
    known = {row.id for row in rows}
    if excluded_ids is not None and not excluded_ids <= known:
        raise HTTPException(422, f"measurements {sorted(excluded_ids - known)} are not in this experiment")

    def excluded(row: AssayMeasurement) -> bool:
        return row.id in excluded_ids if excluded_ids is not None else row.is_excluded

    points = {
        info.key: [
            PointOut(
                measurement_id=row.id,
                replicate=row.replicate_number,
                timepoint=row.timepoint,
                percent_of_t0=row.normalized_value,
                excluded=excluded(row),
                exclusion_reason=row.exclusion_reason if excluded(row) else None,
            )
            for row in rows
            if _arm_key(row, unassigned) == info.key
        ]
        for info in arm_infos
    }
    condition = session.scalar(select(ExperimentCondition).where(ExperimentCondition.experiment_id == experiment_id))
    fu_inc = float(condition.fu_inc) if condition and condition.fu_inc else None
    stage_rows = stages.stages(session, experiment_id)
    by_id = {row.id: row for row in stage_rows}
    sampled, spans_stages = stages.sampled(stage_rows, rows)
    stage_problems = []
    protein = stages.effective_protein(sampled, by_id) if sampled is not None else None
    if spans_stages:
        stage_problems.append("the points come from more than one stage, so CLint was not scaled to protein")
    primary_protein = stages.effective_protein(stage_rows[0], by_id) if stage_rows else None
    fu_inc_withheld = (
        fu_inc is not None
        and sampled is not None
        and sampled.id != stage_rows[0].id
        and not (protein is not None and primary_protein is not None and math.isclose(protein, primary_protein))
    )
    if fu_inc_withheld:
        stage_problems.append("unbound CLint is not shown: fu,inc was measured at the primary stage's protein, not the sampled stage's")

    stage_id_of = {row.stage_type: row.id for row in stage_rows}

    def judged(info: ArmInfo) -> bool:
        sampled_in = {row.stage_id for row in rows if _arm_key(row, unassigned) == info.key}
        return sampled_in <= {stage_id_of.get(info.stage), None}

    science_arms = [
        Arm(
            modulator_id=info.modulator_id,
            label=info.label,
            target_enzyme=info.target_enzyme,
            target_enzymes=tuple(info.target_enzymes),
            points=tuple(
                Point(p.measurement_id, p.replicate, float(p.timepoint), float(p.percent_of_t0), p.excluded)
                for p in points[info.key]
            ),
            key=info.key,
            role=ROLES.get(info.kind, "test"),
            reference_key=info.reference_key,
            group_key=info.group_key,
            concentration=comparable_concentration(info.concentration, info.concentration_unit),
            cofactor_omitted=info.cofactor_omitted,
            judge=judged(info),
        )
        for info in arm_infos
        if points[info.key]
    ]
    analysis = analyze(science_arms, protein, None if fu_inc_withheld else fu_inc)
    fits = {fit.key: fit for fit in analysis.fits}
    inhibitions = {i.key: i for i in analysis.inhibitions}
    negatives = {n.key: n for n in analysis.negatives}
    corrections = {c.key: c for c in analysis.corrections}

    results = []
    for info in arm_infos:
        fit = fits.get(info.key)
        if fit is None:
            continue
        inhibition = inhibitions.get(info.key)
        negative = negatives.get(info.key)
        correction = corrections.get(info.key)
        results.append(
            ArmResult(
                **info.model_dump(),
                points=points[info.key],
                fit=FitOut(
                    k=fit.k,
                    k_se=fit.k_se,
                    half_life_min=fit.half_life_min,
                    half_life_extrapolated=fit.half_life_extrapolated,
                    clint_app=fit.clint_app,
                    clint_app_sd=fit.clint_app_sd,
                    clint_u=fit.clint_u,
                    r_squared=fit.r_squared,
                    t0_backextrapolated=fit.t0_backextrapolated,
                    n_points=fit.n_points,
                    n_excluded=fit.n_excluded,
                    n_replicates=fit.n_replicates,
                    window_min=fit.window_min,
                    fit_line=list(fit.fit_line),
                    problem=fit.problem,
                ),
                inhibition=InhibitionOut(
                    percent=inhibition.percent,
                    se=inhibition.se,
                    ci_low=inhibition.percent - Z95 * inhibition.se,
                    ci_high=inhibition.percent + Z95 * inhibition.se,
                    significant=inhibition.significant,
                    fm_apparent=inhibition.fm_apparent,
                    fm_counted=inhibition.fm_counted,
                    fm_note=inhibition.fm_note,
                )
                if inhibition
                else None,
                negative_check=NegativeCheckOut(
                    percent_remaining_last=negative.percent_remaining_last,
                    last_time_min=negative.last_time_min,
                    n_at_last=negative.n_at_last,
                    k_ratio=negative.k_ratio,
                    k_ratio_se=negative.k_ratio_se,
                    # A baseline was read with its cofactor back, so its loss says nothing about the cofactor.
                    dependent_share=min(1.0, max(0.0, 1 - negative.k_ratio))
                    if info.control_type == "minus_cofactor" and negative.k_ratio is not None and negative.verdict != "not_judged"
                    else None,
                    threshold_percent=NEGATIVE_MIN_PERCENT_REMAINING,
                    verdict=negative.verdict,
                    reason=negative.reason,
                )
                if negative
                else None,
                cofactor_correction=CofactorCorrectionOut(
                    remaining_activity=correction.remaining_activity, se=correction.se, twin_key=correction.twin_key
                )
                if correction
                else None,
            )
        )
    sampled_infos = [info for info in arm_infos if points[info.key]]
    label_of = {info.key: info.label for info in arm_infos}
    # With one reference control, the analysis's own line says it has no data, worded as it always was. With
    # several, each arm names the one it lacks.
    several_references = sum(info.kind == "control" for info in arm_infos) > 1
    unsampled_references = [
        f"{info.label}: its reference {label_of.get(info.reference_key, info.reference_key)} has no measurements, so no % inhibition"
        for info in sampled_infos
        if several_references and info.modulator_id is not None and info.reference_key and not points.get(info.reference_key)
    ]
    if not rows:
        problems = ["no parent-remaining measurements yet: paste data on the Bench data tab"]
    else:
        problems = (
            list(analysis.problems)
            + [info.reference_problem for info in sampled_infos if info.reference_problem]
            + unsampled_references
            + stage_problems
        )
    result = DepletionResult(
        experiment_id=experiment_id,
        protein_mg_per_ml=protein,
        fu_inc=fu_inc,
        fu_inc_withheld=fu_inc_withheld,
        arms=results,
        fm_total=analysis.fm_total,
        fm_unassigned=analysis.fm_unassigned,
        problems=problems,
        checks=list(analysis.checks) + [info.reference_check for info in sampled_infos if info.reference_check],
        method=analysis.method,
        saved=_saved_run(session, experiment_id),
    )
    return result, analysis, arm_infos


def current(session: Session, experiment_id: int) -> DepletionResult:
    return _analysis(session, experiment_id, None)[0]


def preview(session: Session, experiment_id: int, excluded_ids: list[int]) -> DepletionResult:
    return _analysis(session, experiment_id, set(excluded_ids))[0]


def save(session: Session, experiment_id: int, exclusions: list[Exclusion], user: CurrentUser) -> DepletionResult:
    experiment = get_experiment(session, experiment_id)
    reasons = {e.measurement_id: e.reason for e in exclusions}
    rows = _measurements(session, experiment_id)
    unknown = set(reasons) - {row.id for row in rows}
    if unknown:
        raise HTTPException(422, f"measurements {sorted(unknown)} are not in this experiment")
    for row in rows:
        row.is_excluded = row.id in reasons
        row.exclusion_reason = reasons.get(row.id)
    session.flush()

    result, _, _ = _analysis(session, experiment_id, None)
    by_key = {arm.key: arm for arm in result.arms}
    substrate = next(((r.substrate_concentration, r.substrate_concentration_unit) for r in rows), (None, None))
    session.execute(delete(SubstrateDepletionResult).where(SubstrateDepletionResult.experiment_id == experiment_id))
    for arm in result.arms:
        fit = arm.fit
        negative = arm.kind == "negative_control"
        check = arm.negative_check
        if (fit.k is None and not negative) or (negative and fit.k is None and (check is None or check.percent_remaining_last is None)):
            continue
        # Each row records the control it was normalised against: its own for a reference control.
        reference = arm if arm.kind == "control" else by_key.get(arm.reference_key or "")
        fm = arm.inhibition.fm_apparent if arm.inhibition and arm.inhibition.fm_counted else None
        window = f"window {fit.window_min[0]:g}-{fit.window_min[1]:g} min, " if fit.window_min else ""
        session.add(
            SubstrateDepletionResult(
                experiment_id=experiment_id,
                experiment_modulator_id=arm.modulator_id,
                experiment_control_id=arm.control_id,
                reference_control_id=reference.control_id if reference else None,
                substrate_concentration=substrate[0],
                concentration_unit=substrate[1],
                control_depletion_rate=reference.fit.k if reference else None,
                inhibited_depletion_rate=None if arm.kind == "control" else fit.k,
                control_clint=reference.fit.clint_app if reference else None,
                inhibited_clint=None if arm.kind == "control" or negative else fit.clint_app,
                depletion_half_life=fit.half_life_min,
                percent_inhibition_calculated=arm.inhibition.percent if arm.inhibition else None,
                mean_value=check.percent_remaining_last if negative and check else fit.clint_app,
                sd=None if negative else fit.clint_app_sd,
                se=fit.k_se * 1000 / result.protein_mg_per_ml
                if not negative and fit.k_se is not None and result.protein_mg_per_ml
                else None,
                n_replicates=fit.n_replicates,
                value_unit=NEGATIVE_UNIT if negative else VALUE_UNIT,
                calculation_method=f"{result.method} This arm: {window}n = {fit.n_points}, {fit.n_excluded} excluded.",
                computed_by=user.member_id,
                fm_estimate=fm,
                fm_basis=(
                    f"apparent fm from chemical inhibition: {arm.label}"
                    + (f" {arm.concentration:g} {arm.concentration_unit or ''}".rstrip() if arm.concentration is not None else "")
                    + f" -> {arm.target_enzyme}"
                )
                if fm is not None
                else None,
                r_squared=fit.r_squared,
                n_points_used=fit.n_points,
            )
        )
    experiment.updated_at = func.now()
    session.commit()
    return current(session, experiment_id)
