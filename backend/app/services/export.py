"""An experiment's measurements as a CSV file Excel opens without an import dialog: UTF-8 with a byte-order
mark, CRLF line endings, ASCII units, one row per measurement. Every row names its stages, the condition it
was run under and its time in its stage, the control that condition is compared against, the analyte read, the
internal standard and the lots, so the file joins back to the app and feeds Prism. Nothing computed (inhibition,
fm, a verdict) goes in: Prism recomputes those from the points and the named reference."""

import csv
import io
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AssayMeasurement,
    Compound,
    ExperimentCofactor,
    ExperimentControl,
    ExperimentInternalStandard,
    ExperimentModulator,
    Metabolite,
    ReagentLot,
    TissueLot,
)
from app.services import stages
from app.services.depletion import _arm_key, legacy_control_key
from app.services.experiments import arms, get_experiment

COLUMNS = [
    "experiment_code",
    "measurement_id",
    "measured_entity",
    "series_key",
    "series_label",
    "kind",
    "stage_entered",
    "stage_sampled",
    "sampled_protein",
    "sampled_protein_unit",
    "sampled_cell_density",
    "sampled_cell_density_unit",
    "compound",
    "concentration",
    "concentration_unit",
    "control_id",
    "control_label",
    "control_type",
    "omitted_cofactor",
    "protein_override",
    "protein_override_unit",
    "solvent",
    "solvent_percentage",
    "cofactor_omitted",
    "reference_control_id",
    "reference_label",
    "replicate",
    "time",
    "time_unit",
    "raw_value",
    "raw_unit",
    "percent_of_t0",
    "normalized_value",
    "normalized_unit",
    "metabolite_id",
    "excluded",
    "exclusion_reason",
    "substrate",
    "substrate_concentration",
    "substrate_concentration_unit",
    "substrate_lot_id",
    "substrate_lot_number",
    "tissue_lot_id",
    "tissue_lot_number",
    "inhibitor_lot_id",
    "inhibitor_lot_number",
    "cofactor_lot_ids",
    "cofactor_lot_numbers",
    "internal_standard",
    "internal_standard_concentration",
    "internal_standard_unit",
    "internal_standard_addition_step",
    "internal_standard_solvent",
    "internal_standard_lot_id",
    "internal_standard_lot_number",
    "analyte",
    "condition_minutes",
]

# Excel reads a file as UTF-8 only when it starts with this mark.
BYTE_ORDER_MARK = "\ufeff"

# Units are stored in ASCII; these are the only non-ASCII spellings that reach the database through other paths.
ASCII_UNITS = str.maketrans({"µ": "u", "μ": "u", "°": ""})


# A spreadsheet runs a cell that starts with one of these as a formula.
FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def _cell(value) -> str:
    """A value as the CSV shows it: empty for none, TRUE or FALSE for a flag, and a number at full precision, as
    stored for a decimal column and as the shortest exact form for a computed one. Text a person typed that a
    spreadsheet would run as a formula is prefixed with an apostrophe, so it opens as the text it was."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
    if isinstance(value, (Decimal, int)):
        return str(value)
    text = str(value).translate(ASCII_UNITS)
    return f"'{text}" if text.startswith(FORMULA_STARTS) else text


def filename(code: str | None, experiment_id: int) -> str:
    safe = "".join(ch if (ch.isascii() and ch.isalnum()) or ch in "-_" else "-" for ch in (code or f"experiment-{experiment_id}"))
    return f"{safe}-measurements.csv"


def experiment_csv(session: Session, experiment_id: int) -> tuple[str, bytes]:
    experiment = get_experiment(session, experiment_id)
    infos = arms(session, experiment)
    by_key = {info.key: info for info in infos}
    unassigned = legacy_control_key(infos)
    stage_rows = stages.stages(session, experiment_id)
    stage_by_id = {row.id: row for row in stage_rows}
    stage_id_of = {row.stage_type: row.id for row in stage_rows}

    cofactor_rows = list(
        session.scalars(select(ExperimentCofactor).where(ExperimentCofactor.experiment_id == experiment_id).order_by(ExperimentCofactor.id))
    )
    standard = session.scalar(select(ExperimentInternalStandard).where(ExperimentInternalStandard.experiment_id == experiment_id))
    wanted = {experiment.substrate_reagent_lot_id, standard.reagent_lot_id if standard else None}
    wanted |= {row.reagent_lot_id for row in cofactor_rows}
    numbers = dict(
        session.execute(select(ReagentLot.id, ReagentLot.lot_number).where(ReagentLot.id.in_([i for i in wanted if i]))).all()
    )

    def lot_number(lot_id: int | None) -> str | None:
        return numbers.get(lot_id) if lot_id else None

    compounds = dict(
        session.execute(
            select(ExperimentModulator.id, Compound.canonical_name)
            .join(Compound, Compound.id == ExperimentModulator.modulator_compound_id)
            .where(ExperimentModulator.experiment_id == experiment_id)
        ).all()
    )
    omitted_ids = {
        **{
            f"arm-{row.id}": row.omitted_cofactor_id
            for row in session.scalars(select(ExperimentModulator).where(ExperimentModulator.experiment_id == experiment_id))
        },
        **{
            f"ctl-{row.id}": row.omitted_cofactor_id
            for row in session.scalars(select(ExperimentControl).where(ExperimentControl.experiment_id == experiment_id))
        },
    }
    cofactors = [row for row in cofactor_rows if row.component_role == "cofactor"]
    substrate = session.scalar(select(Compound.canonical_name).where(Compound.id == experiment.substrate_compound_id))
    tissue_number = session.scalar(select(TissueLot.lot_number).where(TissueLot.id == experiment.tissue_lot_id))
    standard_name = session.scalar(select(Compound.canonical_name).where(Compound.id == standard.compound_id)) if standard else None

    def left_out(key: str, sampled_stage_id: int | None) -> set[int]:
        """The cofactor rows a condition goes without, while it is read in the stage that leaves them out."""
        info = by_key.get(key)
        if info is None or not (info.cofactor_omitted or info.control_type == "minus_cofactor"):
            return set()
        # In a single endpoint the wells left without a cofactor get buffer in every stage until the read.
        if experiment.sampling != "endpoint" and sampled_stage_id not in (None, stage_id_of.get(info.stage)):
            return set()
        omitted = omitted_ids.get(key)
        return {omitted} if omitted is not None else {row.id for row in cofactors}

    measurements = session.scalars(
        select(AssayMeasurement)
        .where(AssayMeasurement.experiment_id == experiment_id)
        .order_by(AssayMeasurement.replicate_number, AssayMeasurement.timepoint, AssayMeasurement.id)
    ).all()
    metabolites = dict(
        session.execute(
            select(Metabolite.id, func.coalesce(Metabolite.metabolite_name, Metabolite.metabolite_label)).where(
                Metabolite.id.in_({m.metabolite_id for m in measurements if m.metabolite_id is not None})
            )
        ).all()
    )
    order = {info.key: index for index, info in enumerate(infos)}
    rows = sorted(
        measurements,
        key=lambda m: (
            m.metabolite_id is not None,
            metabolites.get(m.metabolite_id, ""),
            order.get(_arm_key(m, unassigned) or "", len(order)),
            m.replicate_number,
            m.timepoint,
            m.id,
        ),
    )

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for m in rows:
        key = _arm_key(m, unassigned)
        info = by_key.get(key or "")
        sampled = stage_by_id.get(m.stage_id) if m.stage_id is not None else None
        no_enzyme = info is not None and info.control_type == "minus_protein"
        lacking = left_out(key or "", m.stage_id)
        present = [row for row in cofactors if row.id not in lacking]
        values = {
            "experiment_code": experiment.experiment_code,
            "measurement_id": m.id,
            "measured_entity": m.measured_entity,
            "series_key": key,
            "series_label": info.label if info else None,
            "kind": info.kind if info else None,
            "stage_entered": info.stage if info else None,
            "stage_sampled": sampled.stage_type if sampled else None,
            "sampled_protein": stages.effective_protein(sampled, stage_by_id) if sampled and not no_enzyme else None,
            "sampled_protein_unit": sampled.protein_concentration_unit if sampled and not no_enzyme else None,
            "sampled_cell_density": sampled.cell_density if sampled and not no_enzyme else None,
            "sampled_cell_density_unit": sampled.cell_density_unit if sampled and not no_enzyme else None,
            "compound": compounds.get(info.modulator_id) if info and info.modulator_id else None,
            "concentration": info.concentration if info else None,
            "concentration_unit": info.concentration_unit if info else None,
            "control_id": info.control_id if info else None,
            "control_label": info.label if info and info.control_id else None,
            "control_type": info.control_type if info else None,
            "omitted_cofactor": info.omitted_cofactor if info else None,
            "protein_override": info.protein_override if info else None,
            "protein_override_unit": "mg/mL" if info and info.protein_override is not None else None,
            "solvent": info.solvent if info else None,
            "solvent_percentage": info.solvent_percentage if info else None,
            "cofactor_omitted": (info.cofactor_omitted or info.control_type == "minus_cofactor") if info else None,
            "reference_control_id": int(info.reference_key.removeprefix("ctl-")) if info and info.reference_key else None,
            "reference_label": info.reference_label if info else None,
            "replicate": m.replicate_number,
            "time": m.timepoint,
            "time_unit": m.timepoint_unit,
            "raw_value": m.raw_value,
            "raw_unit": m.raw_unit,
            "percent_of_t0": m.normalized_value if m.normalized_unit in (None, "% of T0") else None,
            "normalized_value": m.normalized_value,
            "normalized_unit": m.normalized_unit,
            "metabolite_id": m.metabolite_id,
            "excluded": m.is_excluded,
            "exclusion_reason": m.exclusion_reason,
            "substrate": substrate,
            "substrate_concentration": m.substrate_concentration,
            "substrate_concentration_unit": m.substrate_concentration_unit,
            "substrate_lot_id": experiment.substrate_reagent_lot_id,
            "substrate_lot_number": lot_number(experiment.substrate_reagent_lot_id),
            "tissue_lot_id": None if no_enzyme else experiment.tissue_lot_id,
            "tissue_lot_number": None if no_enzyme else tissue_number,
            "inhibitor_lot_id": info.lot.id if info and info.lot else None,
            "inhibitor_lot_number": info.lot.lot_number if info and info.lot else None,
            "cofactor_lot_ids": "; ".join(str(row.reagent_lot_id) for row in present if row.reagent_lot_id) or None,
            "cofactor_lot_numbers": "; ".join(n for row in present if (n := lot_number(row.reagent_lot_id))) or None,
            "internal_standard": standard_name,
            "internal_standard_concentration": standard.concentration if standard else None,
            "internal_standard_unit": standard.concentration_unit if standard else None,
            "internal_standard_addition_step": standard.addition_step if standard else None,
            "internal_standard_solvent": standard.solvent if standard else None,
            "internal_standard_lot_id": standard.reagent_lot_id if standard else None,
            "internal_standard_lot_number": lot_number(standard.reagent_lot_id) if standard else None,
            "analyte": metabolites.get(m.metabolite_id) if m.metabolite_id is not None else substrate,
            "condition_minutes": info.incubation_minutes if info else None,
        }
        writer.writerow([_cell(values[column]) for column in COLUMNS])
    return filename(experiment.experiment_code, experiment_id), (BYTE_ORDER_MARK + out.getvalue()).encode("utf-8")
