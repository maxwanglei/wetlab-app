import datetime as dt
from collections import defaultdict

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, exists, func, null, select
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.models import (
    AssayMeasurement,
    Compound,
    Enzyme,
    Experiment,
    ExperimentCofactor,
    ExperimentCondition,
    ExperimentControl,
    ExperimentEnzyme,
    ExperimentInternalStandard,
    ExperimentModulator,
    ExperimentModulatorExtraTarget,
    ExperimentStage,
    LabMember,
    LcmsSample,
    MetaboliteFormationResult,
    PreparedSolution,
    Protocol,
    ProtocolStep,
    Reagent,
    ReagentLot,
    SubstrateDepletionResult,
    TissueLot,
)
from app.schemas import (
    ArmInfo,
    CofactorIn,
    CofactorOut,
    ControlIn,
    ConditionOut,
    EnzymeRole,
    ExperimentDetail,
    ExperimentDetailsUpdate,
    ExperimentIn,
    ExperimentSummary,
    InternalStandardOut,
    LotRef,
    OmittedComponent,
    PreparedSolutionOut,
    PreparedSolutionUpdate,
    ProtocolOut,
    ReagentComponentOut,
    StatusChanged,
    ProtocolStepOut,
    Quantity,
    TissueLotRef,
)
from app.science import design
from app.services import inventory, lookups, stages

CODE_PREFIX = "WL"
EXPECTED_PATHWAY_ROLES = ("major", "minor", "unknown")


def get_experiment(session: Session, experiment_id: int) -> Experiment:
    experiment = session.get(Experiment, experiment_id)
    if experiment is None:
        raise HTTPException(404, f"experiment {experiment_id} not found")
    return experiment


def _valid_at_use(expiry: dt.date | None, used_on: dt.date | None) -> bool | None:
    return expiry >= used_on if expiry and used_on else None


def _lot_ref(session: Session, lot_id: int | None, used_on: dt.date | None) -> LotRef | None:
    if lot_id is None:
        return None
    lot, reagent_name = session.execute(
        select(ReagentLot, Reagent.name).join(Reagent, Reagent.id == ReagentLot.reagent_id).where(ReagentLot.id == lot_id)
    ).one()
    return LotRef(
        id=lot.id,
        lot_number=lot.lot_number,
        name=reagent_name,
        expiry_date=lot.expiry_date,
        valid_at_use=_valid_at_use(lot.expiry_date, used_on),
    )


def same_name(a: str, b: str) -> bool:
    return " ".join(a.split()).lower() == " ".join(b.split()).lower()


def lot_findings(session: Session, picks: list[tuple[str, str, int | None]]) -> tuple[list[str], list[str]]:
    """For each (what, compound, lot id): a mismatch when the lot's reagent is linked to another compound, and a
    note when it is linked to none, so it cannot be checked. Each lot is reported once per thing it was picked for."""
    mismatches: list[str] = []
    unlinked: list[str] = []
    seen: set[tuple[str, int]] = set()
    for what, name, lot_id in picks:
        if lot_id is None or (what, lot_id) in seen:
            continue
        seen.add((what, lot_id))
        found = session.execute(
            select(ReagentLot.lot_number, Reagent.name, Compound.canonical_name)
            .join(Reagent, Reagent.id == ReagentLot.reagent_id)
            .outerjoin(Compound, Compound.id == Reagent.compound_id)
            .where(ReagentLot.id == lot_id)
        ).first()
        if found is None:
            continue
        number, reagent, compound = found
        # The same rule the form's lot picker uses to list a lot under the compound: its reagent or its compound.
        if same_name(reagent, name) or (compound is not None and same_name(compound, name)):
            continue
        if compound is None:
            unlinked.append(f"{what}: lot {number} ({reagent}) names no compound, so it was not checked against {name}.")
        else:
            mismatches.append(f"{what}: lot {number} is {reagent}, a lot of {compound}, not {name}.")
    return mismatches, unlinked


def summaries(session: Session, experiment_ids: list[int] | None = None) -> list[ExperimentSummary]:
    query = select(Experiment).order_by(Experiment.experiment_date.desc().nulls_last(), Experiment.id.desc())
    if experiment_ids is not None:
        query = query.where(Experiment.id.in_(experiment_ids))
    experiments = session.scalars(query).all()
    compounds = dict(session.execute(select(Compound.id, Compound.canonical_name)).all())
    members = dict(session.execute(select(LabMember.id, LabMember.full_name)).all())
    lots = {
        lot_id: f"{lot_number} ({material})"
        for lot_id, lot_number, material in session.execute(
            select(TissueLot.id, TissueLot.lot_number, TissueLot.material_type)
        )
    }
    counts = dict(
        session.execute(
            select(AssayMeasurement.experiment_id, func.count()).group_by(AssayMeasurement.experiment_id)
        ).all()
    )
    with_results = set(session.scalars(select(SubstrateDepletionResult.experiment_id).distinct()))
    return [
        ExperimentSummary(
            id=e.id,
            code=e.experiment_code,
            title=e.title,
            study_type=e.study_type,
            status=e.status,
            experiment_date=e.experiment_date,
            substrate=compounds.get(e.substrate_compound_id),
            tissue_lot=lots.get(e.tissue_lot_id),
            performed_by=members.get(e.performed_by),
            n_measurements=counts.get(e.id, 0),
            has_results=e.id in with_results,
        )
        for e in experiments
    ]


def _number(value) -> float | None:
    return float(value) if value is not None else None


def _system_contents(session: Session, lot_ids: list[int | None]) -> dict[int, list[ReagentComponentOut]]:
    """What each lot holds, by lot id, for the lots that are regenerating systems."""
    wanted = {lot_id for lot_id in lot_ids if lot_id is not None}
    if not wanted:
        return {}
    by_lot = inventory.components_by_lot(session)
    return {lot_id: by_lot[lot_id] for lot_id in wanted if lot_id in by_lot}


def prepared_solutions(session: Session, ids: list[int] | None = None) -> dict[int, PreparedSolutionOut]:
    """Prepared solutions with their preparer's name, by id; every one, newest first, when no ids are given."""
    query = (
        select(PreparedSolution, LabMember.full_name)
        .outerjoin(LabMember, LabMember.id == PreparedSolution.prepared_by)
        .order_by(PreparedSolution.prepared_on.desc().nulls_last(), PreparedSolution.id.desc())
    )
    if ids is not None:
        if not ids:
            return {}
        query = query.where(PreparedSolution.id.in_(ids))
    return {
        solution.id: PreparedSolutionOut(
            id=solution.id,
            label=solution.label,
            prepared_by=member,
            prepared_on=solution.prepared_on,
            buffer_composition=solution.buffer_composition,
            notes=solution.notes,
        )
        for solution, member in session.execute(query)
    }


def update_prepared_solution(session: Session, solution_id: int, body: PreparedSolutionUpdate) -> PreparedSolutionOut:
    solution = session.get(PreparedSolution, solution_id)
    if solution is None:
        raise HTTPException(404, f"prepared solution {solution_id} not found")
    for field in body.model_fields_set:
        setattr(solution, field, getattr(body, field))
    session.commit()
    return prepared_solutions(session, [solution_id])[solution_id]


# Moving to one of these says the run is done, so its prepared solutions should say who made them.
DONE = ("completed", "qc_passed")


def change_status(session: Session, experiment_id: int, status: str) -> StatusChanged:
    """Any status can follow any other. A move to a finished status is saved even when a prepared solution the
    experiment cites names no preparer; the reply warns about each such solution instead."""
    experiment = get_experiment(session, experiment_id)
    experiment.status = status
    experiment.updated_at = func.now()
    session.commit()
    warnings = []
    if status in DONE:
        unprepared = session.scalars(
            select(PreparedSolution.label)
            .join(ExperimentCofactor, ExperimentCofactor.prepared_solution_id == PreparedSolution.id)
            .where(ExperimentCofactor.experiment_id == experiment_id, PreparedSolution.prepared_by.is_(None))
            .distinct()
            .order_by(PreparedSolution.label)
        )
        warnings = [f"{label} names no preparer. Record who prepared it." for label in unprepared]
    return StatusChanged(status=status, warnings=warnings)


def parent_arms(infos: list[ArmInfo]) -> list[ArmInfo]:
    """The conditions that have a parent compound to measure: every one but a minus-substrate control."""
    return [info for info in infos if info.control_type != "minus_substrate"]


def _extra_targets(session: Session, experiment_id: int) -> dict[int, list[Enzyme]]:
    """Each arm's further target enzymes, by its modulator id, in the order they were named."""
    extras: dict[int, list[Enzyme]] = defaultdict(list)
    for modulator_id, enzyme in session.execute(
        select(ExperimentModulatorExtraTarget.experiment_modulator_id, Enzyme)
        .join(Enzyme, Enzyme.id == ExperimentModulatorExtraTarget.enzyme_id)
        .join(ExperimentModulator, ExperimentModulator.id == ExperimentModulatorExtraTarget.experiment_modulator_id)
        .where(ExperimentModulator.experiment_id == experiment_id)
        .order_by(ExperimentModulatorExtraTarget.experiment_modulator_id, ExperimentModulatorExtraTarget.position)
    ):
        extras[modulator_id].append(enzyme)
    return extras


def arms(session: Session, experiment: Experiment) -> list[ArmInfo]:
    """Every condition, stage by stage: reference controls, then inhibitor arms, then negative controls,
    each in the order it was added. Each arm and negative names the control it is compared against."""
    stage_rows = stages.stages(session, experiment.id)
    stage_suffix = {row.id: f" ({row.stage_type})" if len(stage_rows) > 1 else "" for row in stage_rows}
    condition_solvent, condition_percentage = session.execute(
        select(ExperimentCondition.solvent, ExperimentCondition.solvent_percentage).where(
            ExperimentCondition.experiment_id == experiment.id
        )
    ).first() or (None, None)
    components = {
        row.id: row
        for row in session.scalars(
            select(ExperimentCofactor).where(ExperimentCofactor.experiment_id == experiment.id).order_by(ExperimentCofactor.id)
        )
    }
    contents = _system_contents(session, [row.reagent_lot_id for row in components.values()])
    cofactor_names = {row.id: row.cofactor for row in components.values()}
    expected = set(
        session.scalars(
            select(ExperimentEnzyme.enzyme_id).where(
                ExperimentEnzyme.experiment_id == experiment.id,
                ExperimentEnzyme.pathway_role.in_(EXPECTED_PATHWAY_ROLES),
            )
        )
    )
    controls = list(
        session.scalars(select(ExperimentControl).where(ExperimentControl.experiment_id == experiment.id).order_by(ExperimentControl.id))
    )
    modulators = session.execute(
        select(ExperimentModulator, Compound.canonical_name, Enzyme.enzyme_name)
        .join(Compound, Compound.id == ExperimentModulator.modulator_compound_id)
        .outerjoin(Enzyme, Enzyme.id == ExperimentModulator.target_enzyme_id)
        .where(ExperimentModulator.experiment_id == experiment.id)
        .order_by(ExperimentModulator.id)
    ).all()
    extras = _extra_targets(session, experiment.id)

    def effective(solvent: str | None, percentage) -> dict:
        """A row's solvent with its percentage: its own when it names a solvent, else the conditions'."""
        if solvent:
            return {"solvent": solvent, "solvent_percentage": _number(percentage)}
        return {"solvent": condition_solvent, "solvent_percentage": _number(condition_percentage) if condition_solvent else None}

    stage_minutes = {row.id: _number(row.incubation_minutes) for row in stage_rows}

    def minutes(row: ExperimentModulator | ExperimentControl) -> float | None:
        """A row's time in its stage: its own when set, else its stage's."""
        return _number(row.incubation_minutes) if row.incubation_minutes is not None else stage_minutes.get(row.stage_id)

    # References are resolved on the same effective solvent, percentage and time the API shows for each row.
    specs = [
        design.ControlSpec(
            c.id,
            c.stage_id,
            c.control_type,
            c.label,
            c.solvent,
            None if c.control_type == "complete" else effective(c.solvent, c.solvent_percentage)["solvent_percentage"],
            c.omitted_cofactor_id,
            minutes(c),
        )
        for c in controls
    ]
    # With no reference control anywhere, the analysis says so once; a line per arm would only repeat it.
    any_reference = any(c.control_type in design.REFERENCE_TYPES for c in controls)

    def group_of(modulator: ExperimentModulator) -> str:
        return f"{modulator.stage_id}:{modulator.modulator_compound_id}:{(modulator.arm_label or '').lower()}"

    concentrations: dict[str, set] = defaultdict(set)
    for modulator, _, _ in modulators:
        concentrations[group_of(modulator)].add((modulator.modulator_concentration, modulator.concentration_unit))

    def omitted(cofactor_id: int | None) -> str:
        return cofactor_names.get(cofactor_id, "all") if cofactor_id is not None else "all"

    def omits(cofactor_id: int | None) -> list[OmittedComponent]:
        """What leaving out one component, or every component with the cofactor role, takes away."""
        left_out = [components[cofactor_id]] if cofactor_id in components else [
            row for row in components.values() if cofactor_id is None and row.component_role == "cofactor"
        ]
        return [
            OmittedComponent(component=row.cofactor, contains=[c.component_name for c in contents.get(row.reagent_lot_id, [])])
            for row in left_out
        ]

    def reference(label: str, stage, solvent, percentage, cofactor_omitted, omitted_id, explicit, time, **wording) -> dict:
        found = design.resolve_reference(
            design.ArmSpec(label, stage.id, solvent, percentage, cofactor_omitted, omitted_id, explicit, time),
            specs,
            condition_solvent,
            stage.stage_type,
            **wording,
        )
        return {
            "reference_key": f"ctl-{found.control_id}" if found.control_id is not None else None,
            "reference_source": found.source,
            "reference_problem": found.problem if any_reference or cofactor_omitted else None,
            "reference_check": found.check,
        }

    def negative_reference(control: ExperimentControl, stage) -> dict:
        """The reference a negative control is compared against. In a stage without a reference control it is
        simply not compared; one that can't choose among the stage's references is a problem."""
        found = reference(
            control.label + stage_suffix[stage.id],
            stage,
            control.solvent,
            effective(control.solvent, control.solvent_percentage)["solvent_percentage"],
            False,
            None,
            None,
            minutes(control),
            remedy="give it the solvent and time of the one it goes with",
        )
        in_stage = any(c.stage_id == stage.id and c.control_type in design.REFERENCE_TYPES for c in controls)
        return found | {"reference_problem": found["reference_problem"] if in_stage else None, "reference_check": None}

    def control_info(control: ExperimentControl, stage, kind) -> ArmInfo:
        return ArmInfo(
            key=f"ctl-{control.id}",
            modulator_id=None,
            control_id=control.id,
            control_type=control.control_type,
            kind=kind,
            label=control.label + stage_suffix[stage.id],
            target_enzyme=None,
            concentration=None,
            concentration_unit=None,
            lot=None,
            stage=stage.stage_type,
            **(
                {"solvent": None, "solvent_percentage": None}
                if control.control_type == "complete"
                else effective(control.solvent, control.solvent_percentage)
            ),
            omitted_cofactor=omitted(control.omitted_cofactor_id) if control.control_type == "minus_cofactor" else None,
            omits=omits(control.omitted_cofactor_id) if control.control_type == "minus_cofactor" else [],
            protein_override=_number(control.protein_concentration),
            incubation_minutes=minutes(control),
            replicates=control.replicates,
            **(negative_reference(control, stage) if kind == "negative_control" else {}),
        )

    infos: list[ArmInfo] = []
    for stage in stage_rows:
        in_stage = [c for c in controls if c.stage_id == stage.id]
        infos += [control_info(c, stage, "control") for c in in_stage if c.control_type in design.REFERENCE_TYPES]
        for modulator, compound, target in (row for row in modulators if row[0].stage_id == stage.id):
            label = modulator.arm_label or compound
            if len(concentrations[group_of(modulator)]) > 1 and modulator.modulator_concentration is not None:
                label = f"{label} {float(modulator.modulator_concentration):g} {modulator.concentration_unit or ''}".rstrip()
            if modulator.cofactor_omitted:
                label += f" minus {omitted(modulator.omitted_cofactor_id) if modulator.omitted_cofactor_id else 'cofactor'}"
            further = extras.get(modulator.id, [])
            infos.append(
                ArmInfo(
                    key=f"arm-{modulator.id}",
                    modulator_id=modulator.id,
                    kind="inhibitor"
                    if modulator.target_enzyme_id is None or {modulator.target_enzyme_id, *(e.id for e in further)} & expected
                    else "selectivity_control",
                    label=label + stage_suffix[stage.id],
                    target_enzyme=target,
                    target_enzymes=([target] if target else []) + [e.enzyme_name for e in further],
                    concentration=modulator.modulator_concentration,
                    concentration_unit=modulator.concentration_unit,
                    lot=_lot_ref(session, modulator.reagent_lot_id, experiment.experiment_date),
                    stage=stage.stage_type,
                    group_key=group_of(modulator),
                    **effective(modulator.solvent, modulator.solvent_percentage),
                    cofactor_omitted=modulator.cofactor_omitted,
                    omitted_cofactor=omitted(modulator.omitted_cofactor_id) if modulator.cofactor_omitted else None,
                    omits=omits(modulator.omitted_cofactor_id) if modulator.cofactor_omitted else [],
                    incubation_minutes=minutes(modulator),
                    replicates=modulator.replicates,
                    **reference(
                        label + stage_suffix[stage.id],
                        stage,
                        modulator.solvent,
                        effective(modulator.solvent, modulator.solvent_percentage)["solvent_percentage"],
                        modulator.cofactor_omitted,
                        modulator.omitted_cofactor_id,
                        modulator.reference_control_id,
                        minutes(modulator),
                    ),
                )
            )
        infos += [control_info(c, stage, "negative_control") for c in in_stage if c.control_type not in design.REFERENCE_TYPES]

    labels = design.unique([info.label for info in infos])
    label_of = {info.key: label for info, label in zip(infos, labels, strict=True)}

    def relabelled(line: str | None, info: ArmInfo) -> str | None:
        """A problem or check line that starts with the arm's label, under the label it is finally shown with."""
        prefix = f"{info.label}:"
        return f"{label_of[info.key]}:{line[len(prefix):]}" if line and line.startswith(prefix) else line

    return [
        info.model_copy(
            update={
                "label": label_of[info.key],
                "reference_label": label_of.get(info.reference_key or ""),
                "reference_problem": relabelled(info.reference_problem, info),
                "reference_check": relabelled(info.reference_check, info),
            }
        )
        for info in infos
    ]


def detail(session: Session, experiment_id: int) -> ExperimentDetail:
    experiment = get_experiment(session, experiment_id)
    used_on = experiment.experiment_date
    summary = summaries(session, [experiment.id])[0]

    protocol = None
    if experiment.protocol_id is not None:
        row = session.get(Protocol, experiment.protocol_id)
        steps = session.scalars(
            select(ProtocolStep).where(ProtocolStep.protocol_id == row.id).order_by(ProtocolStep.step_number)
        )
        protocol = ProtocolOut(
            id=row.id,
            code=row.protocol_code,
            name=row.name,
            version=row.version,
            steps=[
                ProtocolStepOut(
                    step_number=s.step_number, instruction=s.instruction, duration=s.duration, duration_unit=s.duration_unit
                )
                for s in steps
            ],
        )

    tissue = None
    if experiment.tissue_lot_id is not None:
        lot = session.get(TissueLot, experiment.tissue_lot_id)
        tissue = TissueLotRef(
            id=lot.id,
            material_type=lot.material_type,
            lot_number=lot.lot_number,
            vendor_or_source=lot.vendor_or_source,
            pooled_or_individual=lot.pooled_or_individual,
            number_of_donors=lot.number_of_donors,
            expiry_date=lot.expiry_date,
            valid_at_use=_valid_at_use(lot.expiry_date, used_on),
        )

    condition_row = session.scalar(select(ExperimentCondition).where(ExperimentCondition.experiment_id == experiment.id))
    condition = ConditionOut.model_validate(condition_row, from_attributes=True) if condition_row else None
    component_rows = list(
        session.scalars(
            select(ExperimentCofactor).where(ExperimentCofactor.experiment_id == experiment.id).order_by(ExperimentCofactor.id)
        )
    )
    contents = _system_contents(session, [c.reagent_lot_id for c in component_rows])
    solutions = prepared_solutions(session, [c.prepared_solution_id for c in component_rows if c.prepared_solution_id])
    cofactors = [
        CofactorOut(
            cofactor=c.cofactor,
            role=c.component_role,
            concentration=c.concentration,
            concentration_unit=c.concentration_unit,
            lot=_lot_ref(session, c.reagent_lot_id, used_on),
            solution=solutions.get(c.prepared_solution_id),
            components=contents.get(c.reagent_lot_id, []),
        )
        for c in component_rows
    ]
    enzymes = [
        EnzymeRole(enzyme=name, pathway_role=role, organ_context=organ)
        for name, role, organ in session.execute(
            select(Enzyme.enzyme_name, ExperimentEnzyme.pathway_role, ExperimentEnzyme.organ_context)
            .join(Enzyme, Enzyme.id == ExperimentEnzyme.enzyme_id)
            .where(ExperimentEnzyme.experiment_id == experiment.id)
            .order_by(ExperimentEnzyme.id)
        )
    ]
    standard_row = session.execute(
        select(ExperimentInternalStandard, Compound.canonical_name)
        .join(Compound, Compound.id == ExperimentInternalStandard.compound_id)
        .where(ExperimentInternalStandard.experiment_id == experiment.id)
    ).first()
    internal_standard = (
        InternalStandardOut(
            compound=standard_row[1],
            concentration=standard_row[0].concentration,
            concentration_unit=standard_row[0].concentration_unit,
            addition_step=standard_row[0].addition_step,
            solvent=standard_row[0].solvent,
            lot=_lot_ref(session, standard_row[0].reagent_lot_id, used_on),
            notes=standard_row[0].notes,
        )
        if standard_row
        else None
    )
    stage_list, warnings = stages.outputs(stages.stages(session, experiment.id))
    stored_picks = [("Substrate", summary.substrate, experiment.substrate_reagent_lot_id)] if summary.substrate else []
    stored_picks += [
        (f"{compound} arm", compound, lot_id)
        for compound, lot_id in session.execute(
            select(Compound.canonical_name, ExperimentModulator.reagent_lot_id)
            .join(Compound, Compound.id == ExperimentModulator.modulator_compound_id)
            .where(ExperimentModulator.experiment_id == experiment.id)
            .order_by(ExperimentModulator.id)
        )
    ]
    if internal_standard is not None and internal_standard.lot is not None:
        stored_picks.append(("Internal standard", internal_standard.compound, internal_standard.lot.id))
    mismatched, unlinked = lot_findings(session, stored_picks)
    warnings = warnings + mismatched + unlinked
    return ExperimentDetail(
        **summary.model_dump(),
        performed_by_id=experiment.performed_by,
        sampling=experiment.sampling,
        has_bench_data=has_bench_data(session, experiment.id),
        objective=experiment.objective,
        notes=experiment.notes,
        protocol=protocol,
        substrate_lot=_lot_ref(session, experiment.substrate_reagent_lot_id, used_on),
        substrate_concentrations=[
            Quantity(value=value, unit=unit)
            for value, unit in session.execute(
                select(AssayMeasurement.substrate_concentration, AssayMeasurement.substrate_concentration_unit)
                .where(
                    AssayMeasurement.experiment_id == experiment.id,
                    AssayMeasurement.substrate_concentration.is_not(None),
                )
                .distinct()
                .order_by(AssayMeasurement.substrate_concentration)
            )
        ],
        tissue=tissue,
        condition=condition,
        cofactors=cofactors,
        internal_standard=internal_standard,
        enzymes=enzymes,
        arms=arms(session, experiment),
        stages=stage_list,
        warnings=warnings,
    )


def _derived_labels(requests: list[ControlIn], cofactors: list[CofactorIn], hepatocytes: bool) -> list[str]:
    """Labels for one stage's controls: each request's own, or one derived from its type. A derived label
    names the solvent when another control of its type in the stage uses a different one, and is numbered
    when it would repeat a label already taken."""
    taken = {c.label.strip().lower() for c in requests if c.label}
    out = []
    for request in requests:
        if request.label:
            out.append(request.label)
            continue
        solvents = {(other.solvent or "").lower() for other in requests if other.control_type == request.control_type}
        base = design.control_label(
            request.control_type,
            solvent=request.solvent,
            solvent_percentage=request.solvent_percentage,
            omitted_cofactor=cofactors[request.omitted_cofactor].cofactor if request.omitted_cofactor is not None else None,
            any_cofactors=any(c.role == "cofactor" for c in cofactors),
            protein=request.protein_concentration,
            hepatocytes=hepatocytes,
            name_solvent=len(solvents) > 1,
        )
        label, number = base, 1
        while label.lower() in taken:
            number += 1
            label = f"{base} {number}"
        taken.add(label.lower())
        out.append(label)
    return out


def next_code(session: Session, year: int) -> str:
    prefix = f"{CODE_PREFIX}-{year}-"
    taken = session.scalars(select(Experiment.experiment_code).where(Experiment.experiment_code.like(f"{prefix}%")))
    numbers = [int(code[len(prefix):]) for code in taken if code[len(prefix):].isdigit()]
    return f"{prefix}{max(numbers, default=0) + 1:03d}"


def _check_lots(session: Session, body: ExperimentIn) -> None:
    """A lot picked for the substrate, an arm or the internal standard must be a lot of that compound when its
    reagent says which."""
    picks = [("Substrate", body.substrate, body.substrate_reagent_lot_id)]
    picks += [(f"{arm.inhibitor} arm", arm.inhibitor, arm.reagent_lot_id) for arm in body.arms]
    if body.internal_standard is not None:
        picks.append(("Internal standard", body.internal_standard.compound, body.internal_standard.reagent_lot_id))
    mismatched, _ = lot_findings(session, picks)
    if mismatched:
        raise HTTPException(422, " ".join(mismatched))


def _set_fields(session: Session, experiment: Experiment, body: ExperimentIn) -> None:
    experiment.title = body.title
    experiment.protocol_id = body.protocol_id
    experiment.study_type = body.study_type
    experiment.experiment_date = body.experiment_date
    experiment.substrate_compound_id = lookups.compound(session, body.substrate).id
    experiment.substrate_reagent_lot_id = body.substrate_reagent_lot_id
    experiment.tissue_lot_id = body.tissue_lot_id
    experiment.objective = body.objective
    experiment.sampling = body.sampling


def create(session: Session, body: ExperimentIn, user: CurrentUser) -> ExperimentDetail:
    """A new experiment starts as planned, with its setup complete and no bench data yet."""
    _check_lots(session, body)
    experiment = Experiment(
        experiment_code=body.code or next_code(session, (body.experiment_date or dt.date.today()).year),
        performed_by=body.performed_by or user.member_id,
        status="planned",
    )
    _set_fields(session, experiment, body)
    session.add(experiment)
    session.flush()
    _write_design(session, experiment, body)
    session.commit()
    return detail(session, experiment.id)


def has_bench_data(session: Session, experiment_id: int) -> bool:
    """Measurements, saved results or LC-MS samples tie rows to the design, so it can no longer change."""
    return any(
        session.scalar(select(exists().where(table.experiment_id == experiment_id)))
        for table in (AssayMeasurement, SubstrateDepletionResult, MetaboliteFormationResult, LcmsSample)
    )


# The design's rows, in an order that deletes each before anything it points at.
DESIGN_TABLES = (
    ExperimentModulator,
    ExperimentControl,
    ExperimentCofactor,
    ExperimentStage,
    ExperimentEnzyme,
    ExperimentInternalStandard,
    ExperimentCondition,
)


def replace_design(session: Session, experiment_id: int, body: ExperimentIn) -> ExperimentDetail:
    """Rewrites the whole design of an experiment that has no bench data yet. Its id, status and, unless the body
    names new ones, its code and who performed it stay."""
    experiment = get_experiment(session, experiment_id)
    if has_bench_data(session, experiment_id):
        raise HTTPException(
            409, "This experiment has bench data, so its design can't change. Its title, objective, date and who performed it still can."
        )
    _check_lots(session, body)
    for table in DESIGN_TABLES:
        session.execute(delete(table).where(table.experiment_id == experiment_id))
    _set_fields(session, experiment, body)
    experiment.experiment_code = body.code or experiment.experiment_code
    experiment.performed_by = body.performed_by or experiment.performed_by
    session.flush()
    _write_design(session, experiment, body)
    session.commit()
    return detail(session, experiment_id)


def update_details(session: Session, experiment_id: int, body: ExperimentDetailsUpdate) -> ExperimentDetail:
    """The descriptive fields, which may change at any time."""
    experiment = get_experiment(session, experiment_id)
    for field in body.model_fields_set:
        setattr(experiment, field, getattr(body, field))
    session.commit()
    return detail(session, experiment_id)


def design_request(session: Session, experiment_id: int) -> ExperimentIn:
    """The experiment's design as the request that would write it again: stored values, not inherited or displayed
    ones, with cofactors and controls named by their place in the list."""
    experiment = get_experiment(session, experiment_id)
    of = lambda table, order=None: session.scalars(  # noqa: E731
        select(table).where(table.experiment_id == experiment_id).order_by(order if order is not None else table.id)
    ).all()
    stage_rows = of(ExperimentStage, ExperimentStage.sequence)
    stage_type = {row.id: row.stage_type for row in stage_rows}
    cofactor_rows = of(ExperimentCofactor)
    cofactor_index = {row.id: index for index, row in enumerate(cofactor_rows)}
    control_rows = of(ExperimentControl)
    control_index = {row.id: index for index, row in enumerate(control_rows)}
    compound = dict(session.execute(select(Compound.id, Compound.canonical_name)).all())
    enzyme = dict(session.execute(select(Enzyme.id, Enzyme.enzyme_name)).all())
    condition = session.scalar(select(ExperimentCondition).where(ExperimentCondition.experiment_id == experiment_id))
    standard = session.scalar(
        select(ExperimentInternalStandard).where(ExperimentInternalStandard.experiment_id == experiment_id)
    )
    extras = _extra_targets(session, experiment_id)
    body = {
        "code": experiment.experiment_code,
        "title": experiment.title,
        "study_type": experiment.study_type,
        "experiment_date": experiment.experiment_date,
        "performed_by": experiment.performed_by,
        "protocol_id": experiment.protocol_id,
        "substrate": compound.get(experiment.substrate_compound_id),
        "substrate_reagent_lot_id": experiment.substrate_reagent_lot_id,
        "tissue_lot_id": experiment.tissue_lot_id,
        "objective": experiment.objective,
        "sampling": experiment.sampling,
        "condition": {
            field: _number(getattr(condition, field)) if field != "buffer" and field != "solvent" else getattr(condition, field)
            for field in ("incubation_temperature", "preincubation_time", "buffer", "ph", "solvent", "solvent_percentage", "fu_inc")
        }
        if condition is not None
        else {},
        "stages": [
            {
                "stage_type": row.stage_type,
                "incubation_minutes": _number(row.incubation_minutes),
                "protein_concentration": _number(row.protein_concentration),
                "cell_density": _number(row.cell_density),
                "cell_density_unit": row.cell_density_unit,
                "dilution_factor": _number(row.dilution_factor),
                "diluted_from": stage_type.get(row.diluted_from_stage_id),
                "notes": row.notes,
            }
            for row in stage_rows
        ],
        "cofactors": [
            {
                "cofactor": row.cofactor,
                "role": row.component_role,
                "concentration": _number(row.concentration),
                "concentration_unit": row.concentration_unit,
                "reagent_lot_id": row.reagent_lot_id,
                "prepared_solution_id": row.prepared_solution_id,
            }
            for row in cofactor_rows
        ],
        "controls": [
            {
                "stage": stage_type.get(row.stage_id),
                "control_type": row.control_type,
                "label": row.label,
                "solvent": row.solvent,
                "solvent_percentage": _number(row.solvent_percentage),
                "omitted_cofactor": cofactor_index.get(row.omitted_cofactor_id),
                "protein_concentration": _number(row.protein_concentration),
                "notes": row.notes,
                "incubation_minutes": _number(row.incubation_minutes),
                "replicates": row.replicates,
            }
            for row in control_rows
        ],
        "internal_standard": None
        if standard is None
        else {
            "compound": compound.get(standard.compound_id),
            "concentration": _number(standard.concentration),
            "concentration_unit": standard.concentration_unit,
            "addition_step": standard.addition_step,
            "solvent": standard.solvent,
            "reagent_lot_id": standard.reagent_lot_id,
            "notes": standard.notes,
        },
        "pathways": [
            {"enzyme": enzyme.get(row.enzyme_id), "pathway_role": row.pathway_role, "organ_context": row.organ_context}
            for row in of(ExperimentEnzyme)
        ],
        "arms": [
            {
                "inhibitor": compound.get(row.modulator_compound_id),
                "role": row.modulator_role,
                "target_enzyme": enzyme.get(row.target_enzyme_id),
                "also_targets": [e.enzyme_name for e in extras.get(row.id, [])],
                "concentration": _number(row.modulator_concentration),
                "concentration_unit": row.concentration_unit,
                "reagent_lot_id": row.reagent_lot_id,
                "stage": stage_type.get(row.stage_id),
                "arm_label": row.arm_label,
                "solvent": row.solvent,
                "solvent_percentage": _number(row.solvent_percentage),
                "cofactor_omitted": row.cofactor_omitted,
                "omitted_cofactor": cofactor_index.get(row.omitted_cofactor_id),
                "reference_control": control_index.get(row.reference_control_id),
                "incubation_minutes": _number(row.incubation_minutes),
                "replicates": row.replicates,
            }
            for row in of(ExperimentModulator)
        ],
    }
    try:
        return ExperimentIn.model_validate(body)
    except ValidationError as error:
        raise HTTPException(409, "This design was recorded in a way the form can't show, so it can't be changed here.") from error


def _write_design(session: Session, experiment: Experiment, body: ExperimentIn) -> None:
    """Writes an experiment's stages, conditions, components, controls, internal standard, pathways and arms."""
    requested = body.stages or stages.from_condition(body.condition)
    primary = requested[0]
    # The conditions row keeps a copy of the primary stage, rewritten with it whenever the design is.
    condition = body.condition.model_dump() | {
        "incubation_time": primary.incubation_minutes,
        "protein_concentration": primary.protein_concentration,
        "cell_density": primary.cell_density,
        "cell_density_unit": primary.cell_density_unit,
    }
    session.add(ExperimentCondition(experiment_id=experiment.id, **condition))
    stage_by_type = stages.create(session, experiment.id, requested)
    cofactor_rows = []
    for c in body.cofactors:
        solution_id = c.prepared_solution_id
        if c.solution is not None:
            solution = PreparedSolution(**c.solution.model_dump())
            session.add(solution)
            session.flush()
            solution_id = solution.id
        cofactor_rows.append(
            ExperimentCofactor(
                experiment_id=experiment.id,
                cofactor=c.cofactor,
                component_role=c.role,
                concentration=c.concentration,
                concentration_unit=c.concentration_unit,
                reagent_lot_id=c.reagent_lot_id,
                prepared_solution_id=solution_id,
            )
        )
    session.add_all(cofactor_rows)
    session.flush()
    requests = body.controls if body.controls is not None else [ControlIn(stage=s.stage_type, control_type="vehicle") for s in requested]
    hepatocytes = body.study_type == "hepatocyte_stability"
    control_rows = []
    for stage_type, stage in stage_by_type.items():
        in_stage = [(index, c) for index, c in enumerate(requests) if c.stage == stage_type]
        labels = _derived_labels([c for _, c in in_stage], body.cofactors, hepatocytes)
        for (index, c), label in zip(in_stage, labels, strict=True):
            control_rows.append(
                (
                    index,
                    ExperimentControl(
                        experiment_id=experiment.id,
                        stage_id=stage.id,
                        control_type=c.control_type,
                        label=label,
                        solvent=c.solvent,
                        solvent_percentage=c.solvent_percentage,
                        omitted_cofactor_id=cofactor_rows[c.omitted_cofactor].id if c.omitted_cofactor is not None else None,
                        protein_concentration=c.protein_concentration,
                        notes=c.notes,
                        incubation_minutes=c.incubation_minutes,
                        replicates=c.replicates,
                    ),
                )
            )
    session.add_all(row for _, row in control_rows)
    session.flush()
    control_at = dict(control_rows)
    if body.internal_standard is not None:
        standard = body.internal_standard
        session.add(
            ExperimentInternalStandard(
                experiment_id=experiment.id,
                compound_id=lookups.compound(session, standard.compound).id,
                concentration=standard.concentration,
                concentration_unit=standard.concentration_unit,
                addition_step=standard.addition_step,
                # An explicit null means no solvent; left as None, the column's own default would fill it in.
                solvent=standard.solvent if standard.solvent is not None else null(),
                reagent_lot_id=standard.reagent_lot_id,
                notes=standard.notes,
            )
        )
    for pathway in body.pathways:
        session.add(
            ExperimentEnzyme(
                experiment_id=experiment.id,
                enzyme_id=lookups.enzyme(session, pathway.enzyme).id,
                organ_context=pathway.organ_context,
                pathway_role=pathway.pathway_role,
            )
        )
    for arm in body.arms:
        modulator = ExperimentModulator(
            experiment_id=experiment.id,
            stage_id=stage_by_type[arm.stage].id,
            modulator_compound_id=lookups.compound(session, arm.inhibitor).id,
            modulator_role=arm.role,
            target_enzyme_id=lookups.enzyme(session, arm.target_enzyme).id if arm.target_enzyme else None,
            modulator_concentration=arm.concentration,
            concentration_unit=arm.concentration_unit,
            reagent_lot_id=arm.reagent_lot_id,
            arm_label=arm.arm_label,
            solvent=arm.solvent,
            solvent_percentage=arm.solvent_percentage,
            cofactor_omitted=arm.cofactor_omitted,
            omitted_cofactor_id=cofactor_rows[arm.omitted_cofactor].id if arm.omitted_cofactor is not None else None,
            reference_control_id=control_at[arm.reference_control].id if arm.reference_control is not None else None,
            incubation_minutes=arm.incubation_minutes,
            replicates=arm.replicates,
        )
        session.add(modulator)
        session.flush()
        session.add_all(
            ExperimentModulatorExtraTarget(experiment_modulator_id=modulator.id, enzyme_id=lookups.enzyme(session, name).id, position=position)
            for position, name in enumerate(arm.also_targets, start=1)
        )
    session.flush()
