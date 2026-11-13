from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import AssayMeasurement, Compound, Experiment, Metabolite, SubstrateDepletionResult
from app.schemas import (
    Analyte,
    ArmInfo,
    Measurements,
    MeasurementRow,
    PastePreview,
    PastePreviewRequest,
    ReplaceMeasurements,
)
from app.services.depletion import _arm_key, _measurements, legacy_control_key
from app.services import lookups, stages
from app.services.experiments import arms, get_experiment, parent_arms
from app.services.paste import endpoint_template_columns, parse_endpoint_grid, parse_grid, template_columns

PARENT_ONLY = "A time-course experiment records the parent compound only."


def _row_out(row: AssayMeasurement, key: str) -> MeasurementRow:
    return MeasurementRow(
        id=row.id,
        arm_key=key,
        replicate=row.replicate_number,
        timepoint=row.timepoint,
        raw_value=row.raw_value,
        raw_unit=row.raw_unit,
        percent_of_t0=row.normalized_value,
        is_excluded=row.is_excluded,
        exclusion_reason=row.exclusion_reason,
        well_position=row.well_position,
    )


def listing(session: Session, experiment_id: int, metabolite: str | None = None) -> Measurements:
    experiment = get_experiment(session, experiment_id)
    arm_infos = arms(session, experiment)
    if metabolite is None:
        arm_infos = parent_arms(arm_infos)
    if experiment.sampling == "endpoint":
        return _endpoint_listing(session, experiment, arm_infos, metabolite)
    if metabolite is not None:
        raise HTTPException(422, PARENT_ONLY)
    unassigned = legacy_control_key(arm_infos)
    rows = [row for row in _measurements(session, experiment_id) if _arm_key(row, unassigned) is not None]
    replicates = max((row.replicate_number for row in rows), default=3)
    sampled, spans = stages.sampled(stages.stages(session, experiment_id), rows)
    return Measurements(
        stage=sampled.stage_type if rows and sampled is not None and not spans else None,
        arms=arm_infos,
        rows=[_row_out(row, _arm_key(row, unassigned)) for row in rows],
        template_columns=template_columns(arm_infos, replicates),
    )


def _of_analyte(experiment_id: int, metabolite: Metabolite | None) -> tuple:
    """The filter for one analyte's rows: the parent's when no metabolite is given."""
    return (
        AssayMeasurement.experiment_id == experiment_id,
        AssayMeasurement.measured_entity == ("metabolite_formation" if metabolite else "parent_remaining"),
        AssayMeasurement.metabolite_id.is_not_distinct_from(metabolite.id if metabolite else None),
    )


def _analytes(session: Session, experiment: Experiment) -> list[Analyte]:
    """The analytes an endpoint experiment has data for: the parent first, then each metabolite by name."""
    found = session.execute(
        select(AssayMeasurement.metabolite_id, func.coalesce(Metabolite.metabolite_name, Metabolite.metabolite_label))
        .outerjoin(Metabolite, Metabolite.id == AssayMeasurement.metabolite_id)
        .where(AssayMeasurement.experiment_id == experiment.id)
        .distinct()
    ).all()
    substrate = session.scalar(select(Compound.canonical_name).where(Compound.id == experiment.substrate_compound_id))
    parent = [Analyte(name=substrate, metabolite=None)] if any(metabolite_id is None for metabolite_id, _ in found) else []
    return parent + sorted(
        (Analyte(name=name, metabolite=name) for metabolite_id, name in found if metabolite_id is not None), key=lambda a: a.name.lower()
    )


def _endpoint_listing(session: Session, experiment: Experiment, arm_infos: list[ArmInfo], metabolite: str | None) -> Measurements:
    found = lookups.find_metabolite(session, experiment.substrate_compound_id, metabolite) if metabolite else None
    query = select(AssayMeasurement).where(*_of_analyte(experiment.id, found)).order_by(AssayMeasurement.replicate_number, AssayMeasurement.id)
    rows = [] if metabolite and found is None else list(session.scalars(query))
    sampled, spans = stages.sampled(stages.stages(session, experiment.id), rows)
    return Measurements(
        stage=sampled.stage_type if rows and sampled is not None and not spans else None,
        arms=arm_infos,
        rows=[_row_out(row, _arm_key(row, None)) for row in rows],
        template_columns=endpoint_template_columns(arm_infos),
        analytes=_analytes(session, experiment),
    )


def preview(session: Session, experiment_id: int, body: PastePreviewRequest) -> PastePreview:
    experiment = get_experiment(session, experiment_id)
    arm_infos = arms(session, experiment)
    if body.metabolite is None:
        arm_infos = parent_arms(arm_infos)
    if experiment.sampling != "endpoint":
        if body.metabolite is not None:
            raise HTTPException(422, PARENT_ONLY)
        return parse_grid(body.text, arm_infos, body.value_kind)
    if body.value_kind == "percent_of_t0":
        raise HTTPException(422, "A single endpoint is pasted as area ratios, not % of T0.")
    minutes = stages.endpoint_minutes(stages.stages(session, experiment_id))
    return parse_endpoint_grid(body.text, arm_infos, minutes, metabolite=body.metabolite is not None)


def replace(session: Session, experiment_id: int, body: ReplaceMeasurements) -> Measurements:
    """Replace the experiment's parent-remaining rows; saved results go too, since they described the old data. A
    single endpoint replaces only the rows of the analyte pasted."""
    experiment = get_experiment(session, experiment_id)
    arm_infos = arms(session, experiment)
    known = {info.key: info for info in (parent_arms(arm_infos) if body.metabolite is None else arm_infos)}
    unknown = {row.arm_key for row in body.rows} - set(known)
    if unknown:
        raise HTTPException(422, f"arms {sorted(unknown)} are not in this experiment")
    if experiment.sampling == "endpoint":
        return _replace_endpoint(session, experiment, body, known)
    if body.metabolite is not None:
        raise HTTPException(422, PARENT_ONLY)
    if any(row.percent_of_t0 is None for row in body.rows):
        raise HTTPException(422, "Every time-course value needs its % of T0.")
    if len({(row.arm_key, row.replicate, row.timepoint) for row in body.rows}) != len(body.rows):
        raise HTTPException(422, "Each condition, replicate and timepoint can be pasted once.")
    previous = _measurements(session, experiment_id)
    substrate = next(((r.substrate_concentration, r.substrate_concentration_unit) for r in previous), (None, None))
    if body.substrate_concentration is not None:
        substrate = (body.substrate_concentration, body.substrate_concentration_unit or "uM")
    stage = stages.for_paste(session, experiment_id, body.stage, previous)

    session.execute(delete(SubstrateDepletionResult).where(SubstrateDepletionResult.experiment_id == experiment_id))
    session.execute(
        delete(AssayMeasurement).where(
            AssayMeasurement.experiment_id == experiment_id,
            AssayMeasurement.measured_entity == "parent_remaining",
        )
    )
    session.add_all(
        AssayMeasurement(
            experiment_id=experiment_id,
            experiment_modulator_id=known[row.arm_key].modulator_id,
            experiment_control_id=known[row.arm_key].control_id,
            stage_id=stage.id if stage is not None else None,
            replicate_number=row.replicate,
            substrate_concentration=substrate[0],
            substrate_concentration_unit=substrate[1],
            timepoint=row.timepoint,
            timepoint_unit="min",
            measured_entity="parent_remaining",
            raw_value=row.raw_value,
            raw_unit="area_ratio" if row.raw_value is not None else None,
            normalized_value=row.percent_of_t0,
            normalized_unit="% of T0",
        )
        for row in body.rows
    )
    experiment.updated_at = func.now()
    session.commit()
    return listing(session, experiment_id)


def _replace_endpoint(session: Session, experiment: Experiment, body: ReplaceMeasurements, known: dict[str, ArmInfo]) -> Measurements:
    minutes = stages.endpoint_minutes(stages.stages(session, experiment.id))
    if minutes is None:
        raise HTTPException(422, "Give the last stage an incubation time: a single endpoint is read at its end.")
    for row in body.rows:
        info = known[row.arm_key]
        if row.raw_value is None or row.raw_value < 0 or (row.raw_value == 0 and body.metabolite is None):
            raise HTTPException(422, f"{info.label} R{row.replicate}: a parent's area ratio must be more than 0, a metabolite's 0 or more.")
        if row.replicate > info.replicates:
            raise HTTPException(422, f"{info.label} plans {info.replicates} replicates, not {row.replicate}.")
    if len({(row.arm_key, row.replicate) for row in body.rows}) < len(body.rows):
        raise HTTPException(422, "Each replicate of a condition can be pasted once.")
    metabolite = lookups.metabolite(session, experiment.substrate_compound_id, body.metabolite) if body.metabolite else None
    previous = list(session.scalars(select(AssayMeasurement).where(AssayMeasurement.experiment_id == experiment.id)))
    substrate = next(((r.substrate_concentration, r.substrate_concentration_unit) for r in previous), (None, None))
    if body.substrate_concentration is not None:
        substrate = (body.substrate_concentration, body.substrate_concentration_unit or "uM")
    stage = stages.for_paste(session, experiment.id, body.stage, previous)

    session.execute(delete(AssayMeasurement).where(*_of_analyte(experiment.id, metabolite)))
    session.add_all(
        AssayMeasurement(
            experiment_id=experiment.id,
            experiment_modulator_id=known[row.arm_key].modulator_id,
            experiment_control_id=known[row.arm_key].control_id,
            stage_id=stage.id if stage is not None else None,
            replicate_number=row.replicate,
            substrate_concentration=substrate[0],
            substrate_concentration_unit=substrate[1],
            timepoint=minutes,
            timepoint_unit="min",
            measured_entity="metabolite_formation" if metabolite else "parent_remaining",
            metabolite_id=metabolite.id if metabolite else None,
            raw_value=row.raw_value,
            raw_unit="area_ratio",
        )
        for row in body.rows
    )
    experiment.updated_at = func.now()
    session.commit()
    return listing(session, experiment.id, body.metabolite)
