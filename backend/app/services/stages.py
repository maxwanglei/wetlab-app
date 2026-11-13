"""An experiment's stages: each incubation's time and protein, and the dilution that links one stage to the next."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AssayMeasurement, ExperimentStage
from app.schemas import ConditionIn, StageIn, StageOut, StageType

# A diluted stage's entered protein may differ from the derived one by this fraction before a warning.
DILUTION_TOLERANCE = 0.01


def stages(session: Session, experiment_id: int) -> list[ExperimentStage]:
    return list(
        session.scalars(
            select(ExperimentStage).where(ExperimentStage.experiment_id == experiment_id).order_by(ExperimentStage.sequence)
        )
    )


def from_condition(condition: ConditionIn) -> list[StageIn]:
    """The single primary stage an experiment gets when its request names no stages."""
    return [
        StageIn(
            stage_type="primary",
            incubation_minutes=condition.incubation_time,
            protein_concentration=condition.protein_concentration,
            cell_density=condition.cell_density,
            cell_density_unit=condition.cell_density_unit,
        )
    ]


def create(session: Session, experiment_id: int, requested: list[StageIn]) -> dict[StageType, ExperimentStage]:
    by_type: dict[StageType, ExperimentStage] = {}
    for sequence, stage in enumerate(requested, start=1):
        row = ExperimentStage(
            experiment_id=experiment_id,
            stage_type=stage.stage_type,
            sequence=sequence,
            incubation_minutes=stage.incubation_minutes,
            protein_concentration=stage.protein_concentration,
            cell_density=stage.cell_density,
            cell_density_unit=stage.cell_density_unit,
            dilution_factor=stage.dilution_factor,
            diluted_from_stage_id=by_type[stage.diluted_from].id if stage.diluted_from else None,
            notes=stage.notes,
        )
        session.add(row)
        session.flush()
        by_type[stage.stage_type] = row
    return by_type


def _number(value) -> float | None:
    return float(value) if value is not None else None


def derived_protein(stage: ExperimentStage, by_id: dict[int, ExperimentStage]) -> float | None:
    source = by_id.get(stage.diluted_from_stage_id) if stage.diluted_from_stage_id is not None else None
    if source is None or stage.dilution_factor is None:
        return None
    protein = effective_protein(source, by_id)
    return protein / float(stage.dilution_factor) if protein is not None else None


def outputs(rows: list[ExperimentStage]) -> tuple[list[StageOut], list[str]]:
    by_id = {row.id: row for row in rows}
    out: list[StageOut] = []
    warnings: list[str] = []
    for row in rows:
        derived = derived_protein(row, by_id)
        entered = _number(row.protein_concentration)
        source = by_id.get(row.diluted_from_stage_id) if row.diluted_from_stage_id is not None else None
        if derived is not None and entered is not None and abs(entered - derived) > DILUTION_TOLERANCE * derived:
            warnings.append(
                f"{row.stage_type.capitalize()} stage: {entered:g} mg/mL entered, but {effective_protein(source, by_id):g} mg/mL "
                f"diluted {float(row.dilution_factor):g}-fold gives {derived:g} mg/mL."
            )
        out.append(
            StageOut(
                id=row.id,
                stage_type=row.stage_type,
                sequence=row.sequence,
                incubation_minutes=_number(row.incubation_minutes),
                protein_concentration=entered,
                protein_concentration_unit=row.protein_concentration_unit,
                cell_density=_number(row.cell_density),
                cell_density_unit=row.cell_density_unit,
                dilution_factor=_number(row.dilution_factor),
                diluted_from=source.stage_type if source is not None else None,
                derived_protein_concentration=derived,
                notes=row.notes,
            )
        )
    return out, warnings


def for_paste(
    session: Session, experiment_id: int, stage_type: StageType | None, previous: list[AssayMeasurement]
) -> ExperimentStage | None:
    """The stage pasted samples were taken from: the one named; else the stage of the rows they replace,
    as the substrate concentration is kept; else the last. None for an experiment written before stages
    existed, which scripts/backfill.py repairs."""
    rows = stages(session, experiment_id)
    if not rows:
        return None
    if stage_type is not None:
        match = next((row for row in rows if row.stage_type == stage_type), None)
        if match is None:
            raise HTTPException(422, f"this experiment has no {stage_type} stage")
        return match
    kept, _ = sampled(rows, previous)
    return kept if kept is not None else rows[-1]


def endpoint_minutes(rows: list[ExperimentStage]) -> float | None:
    """When a single endpoint is read: at the end of the last stage."""
    return _number(rows[-1].incubation_minutes) if rows else None


def effective_protein(stage: ExperimentStage, by_id: dict[int, ExperimentStage]) -> float | None:
    """The stage's own protein concentration, or, when it was left blank, the one its dilution implies."""
    if stage.protein_concentration is not None:
        return float(stage.protein_concentration)
    return derived_protein(stage, by_id)


def sampled(rows: list[ExperimentStage], measurements: list[AssayMeasurement]) -> tuple[ExperimentStage | None, bool]:
    """The stage the points were sampled in, and whether they span more than one stage. With no points yet,
    the stage a paste would write to."""
    if not rows:
        return None, False
    stage_ids = {m.stage_id for m in measurements}
    if not stage_ids:
        return rows[-1], False
    if len(stage_ids) > 1:
        return None, True
    (stage_id,) = stage_ids
    by_id = {row.id: row for row in rows}
    return by_id.get(stage_id, rows[0]) if stage_id is not None else rows[0], False
