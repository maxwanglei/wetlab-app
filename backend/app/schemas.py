import datetime as dt
from typing import Annotated, Literal, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

LotFlag = Literal["expired", "expiring_soon", "low_stock", "depleted"]
ArmKind = Literal["control", "negative_control", "inhibitor", "selectivity_control"]
ControlType = Literal["vehicle", "complete", "minus_cofactor", "minus_substrate", "minus_protein", "heat_inactivated", "other"]
ReferenceSource = Literal["explicit", "matched", "fallback"]
Verdict = Literal["pass", "flag", "not_judged"]
AdditionStep = Literal["reaction_termination", "sample_preparation", "reconstitution", "other"]
ExclusionReason = Literal[
    "pipetting error", "carryover", "missing peak", "integration failure", "sample lost", "other"
]
ValueKind = Literal["percent_of_t0", "area_ratio"]
StudyType = Literal[
    "substrate_depletion", "metabolite_formation", "recombinant_enzyme", "chemical_inhibition",
    "antibody_inhibition", "hepatocyte_stability", "S9_metabolism", "cytosol_metabolism",
]
ReagentType = Literal[
    "substrate", "inhibitor", "inducer", "probe_substrate", "cofactor", "solvent", "buffer", "internal_standard", "other",
    "regenerating_system",
]
ComponentRole = Literal["solvent", "cofactor", "substrate", "other"]
ExperimentStatus = Literal["planned", "in_progress", "completed", "failed", "qc_passed", "qc_failed"]
PathwayRole = Literal["major", "minor", "unknown"]
ModulatorRole = Literal["inhibitor", "inducer", "probe_substrate", "antibody_inhibitor"]
OrganContext = Literal["hepatic", "intestinal", "renal", "plasma"]
StageType = Literal["primary", "secondary", "tertiary"]
Sampling = Literal["time_course", "endpoint"]
STAGE_ORDER: tuple[StageType, ...] = ("primary", "secondary", "tertiary")

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Finite = Annotated[float, Field(allow_inf_nan=False)]
NonNegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Positive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Replicates = Annotated[int, Field(ge=1, le=12)]


class Health(BaseModel):
    status: Literal["ok"]
    database: str
    version: str
    demo: bool = Field(description="the database holds made-up sample data: its name ends in _demo")


class Me(BaseModel):
    email: str
    full_name: str
    member_id: int
    is_admin: bool


Password = Annotated[str, StringConstraints(max_length=200)]
Email = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+$")]


class LoginIn(BaseModel):
    email: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
    password: Password


class PasswordChange(BaseModel):
    current_password: Password
    new_password: Password


class PasswordSet(BaseModel):
    new_password: Password


class MemberOut(BaseModel):
    id: int
    full_name: str
    email: str | None
    role: str | None
    is_admin: bool
    is_active: bool
    can_sign_in: bool = Field(description="active and has a password")


class MemberIn(BaseModel):
    full_name: Name
    email: Email
    role: Name | None = None
    is_admin: bool = False
    password: Password


class MemberUpdate(BaseModel):
    full_name: Name | None = None
    email: Email | None = None
    role: Name | None = None
    is_admin: bool | None = None
    is_active: bool | None = None


class LotRef(BaseModel):
    id: int
    lot_number: str
    name: str
    expiry_date: dt.date | None
    valid_at_use: bool | None = None


class ReagentComponentOut(BaseModel):
    component_name: str
    amount: float | None
    amount_unit: str | None
    lot_number: str | None = Field(description="the lot the component came from, when recorded")


class ReagentLotRow(BaseModel):
    id: int
    reagent: str
    reagent_type: str | None
    compound: str | None
    lot_number: str
    vendor: str | None
    catalog_number: str | None
    concentration: float | None
    concentration_unit: str | None
    received_date: dt.date | None
    expiry_date: dt.date | None
    days_to_expiry: int | None
    storage_temp_c: float | None
    quantity_received: float | None
    quantity_remaining: float | None
    quantity_unit: str | None
    percent_remaining: float | None
    is_depleted: bool
    flags: list[LotFlag]
    notes: str | None
    components: list[ReagentComponentOut] = Field(default=[], description="what this lot of a regenerating system holds")


class TissueLotRow(BaseModel):
    id: int
    material_type: str | None
    species: str | None
    lot_number: str | None
    vendor_or_source: str | None
    catalog_number: str | None
    pooled_or_individual: str | None
    number_of_donors: int | None
    protein_concentration: float | None
    protein_concentration_unit: str | None
    viability: float | None
    received_date: dt.date | None
    expiry_date: dt.date | None
    days_to_expiry: int | None
    storage_temp_c: float | None
    quantity_remaining: float | None
    quantity_unit: str | None
    is_depleted: bool
    notes: str | None
    flags: list[LotFlag]


class Donor(BaseModel):
    donor_id_in_source: str | None
    sex: str | None
    age_min: float | None
    age_max: float | None
    bmi: float | None
    disease_state: str | None
    genotype_available: bool | None


class ExperimentRef(BaseModel):
    id: int
    code: str | None
    title: str | None
    status: str
    experiment_date: dt.date | None


class TissueLotDetail(TissueLotRow):
    donors: list[Donor]
    used_in: list[ExperimentRef]


class ExperimentSummary(BaseModel):
    id: int
    code: str | None
    title: str | None
    study_type: str
    status: str
    experiment_date: dt.date | None
    substrate: str | None
    tissue_lot: str | None
    performed_by: str | None
    n_measurements: int
    has_results: bool


class StatusCount(BaseModel):
    status: str
    count: int


class LotAlert(BaseModel):
    kind: Literal["reagent", "tissue"]
    id: int
    name: str
    lot_number: str | None
    expiry_date: dt.date | None
    days_to_expiry: int | None
    quantity_remaining: float | None
    quantity_unit: str | None
    percent_remaining: float | None
    flags: list[LotFlag]


class Dashboard(BaseModel):
    experiments_by_status: list[StatusCount]
    recent_experiments: list[ExperimentSummary]
    lot_alerts: list[LotAlert]


class ProtocolStepOut(BaseModel):
    step_number: int
    instruction: str
    duration: float | None
    duration_unit: str | None


class ProtocolOut(BaseModel):
    id: int
    code: str | None
    name: str
    version: str
    steps: list[ProtocolStepOut]


class ConditionOut(BaseModel):
    protein_concentration: float | None
    protein_concentration_unit: str | None
    cell_density: float | None
    cell_density_unit: str | None
    incubation_temperature: float | None
    incubation_temperature_unit: str | None
    incubation_time: float | None
    incubation_time_unit: str | None
    preincubation_time: float | None
    preincubation_time_unit: str | None
    buffer: str | None
    ph: float | None
    solvent: str | None
    solvent_percentage: float | None
    linearity_confirmed: str | None
    fu_inc: float | None


class PreparedSolutionOut(BaseModel):
    id: int
    label: str
    prepared_by: str | None
    prepared_on: dt.date | None
    buffer_composition: str | None
    notes: str | None


class CofactorOut(BaseModel):
    """One component of the incubation besides the substrate and the enzyme source."""

    cofactor: str
    role: ComponentRole | None = Field(description="null when it was never classified")
    concentration: float | None
    concentration_unit: str | None
    lot: LotRef | None
    solution: PreparedSolutionOut | None = Field(description="the prepared solution it came from")
    components: list[ReagentComponentOut] = Field(description="what its lot holds, when the lot is a regenerating system")


class InternalStandardOut(BaseModel):
    compound: str
    concentration: float | None
    concentration_unit: str | None
    addition_step: AdditionStep
    solvent: str | None
    lot: LotRef | None
    notes: str | None


class EnzymeRole(BaseModel):
    enzyme: str
    pathway_role: str | None
    organ_context: str | None


class OmittedComponent(BaseModel):
    component: str
    contains: list[str] = Field(description="a regenerating system's own components, all left out with it")


class ArmInfo(BaseModel):
    """One condition samples were incubated under: an inhibitor arm at one concentration, or a control."""

    key: str = Field(description="'arm-<experiment_modulator id>' or 'ctl-<experiment_control id>'")
    modulator_id: int | None
    control_id: int | None = None
    control_type: ControlType | None = None
    kind: ArmKind
    label: str
    target_enzyme: str | None
    target_enzymes: list[str] = Field(default=[], description="the target enzyme, then the further targets the inhibitor names")
    concentration: float | None
    concentration_unit: str | None
    lot: LotRef | None
    stage: StageType | None = None
    group_key: str | None = Field(default=None, description="shared by one inhibitor's concentrations in one stage")
    solvent: str | None = Field(default=None, description="the effective solvent, inherited from the conditions when not set")
    solvent_percentage: float | None = Field(default=None, description="the effective solvent's percentage, inherited with it")
    cofactor_omitted: bool = False
    omitted_cofactor: str | None = Field(default=None, description="the omitted cofactor's name, or 'all'")
    protein_override: float | None = None
    incubation_minutes: float | None = Field(default=None, description="its time in its stage: its own, else the stage's")
    replicates: int = Field(default=3, description="the wells planned for it, read once each in a single-endpoint experiment")
    reference_key: str | None = Field(default=None, description="the key of the control this arm is compared against")
    reference_label: str | None = None
    reference_source: ReferenceSource | None = None
    reference_problem: str | None = Field(default=None, description="why no reference could be chosen")
    reference_check: str | None = Field(default=None, description="a reference chosen as the stage's only one")
    omits: list[OmittedComponent] = Field(
        default=[], description="the components a minus-cofactor control, or an arm run without cofactor, leaves out"
    )


class Quantity(BaseModel):
    value: float
    unit: str | None


class TissueLotRef(BaseModel):
    id: int
    material_type: str | None
    lot_number: str | None
    vendor_or_source: str | None
    pooled_or_individual: str | None
    number_of_donors: int | None
    expiry_date: dt.date | None
    valid_at_use: bool | None


class StageOut(BaseModel):
    id: int
    stage_type: StageType
    sequence: int
    incubation_minutes: float | None
    protein_concentration: float | None
    protein_concentration_unit: str | None
    cell_density: float | None
    cell_density_unit: str | None
    dilution_factor: float | None
    diluted_from: StageType | None
    derived_protein_concentration: float | None = Field(
        description="the source stage's protein concentration divided by the dilution factor"
    )
    notes: str | None


class ExperimentDetail(ExperimentSummary):
    performed_by_id: int | None
    sampling: Sampling
    has_bench_data: bool = Field(description="measurements, saved results or LC-MS samples exist, so the design is fixed")
    objective: str | None
    notes: str | None
    protocol: ProtocolOut | None
    substrate_lot: LotRef | None
    substrate_concentrations: list[Quantity] = Field(description="distinct values recorded in the bench data")
    tissue: TissueLotRef | None
    condition: ConditionOut | None
    cofactors: list[CofactorOut]
    internal_standard: InternalStandardOut | None = Field(description="added to every sample to normalise the LC-MS signal")
    enzymes: list[EnzymeRole]
    arms: list[ArmInfo]
    stages: list[StageOut]
    warnings: list[str] = Field(
        description="setup values that disagree, such as a diluted protein concentration or a lot of another compound"
    )


class MeasurementRow(BaseModel):
    id: int
    arm_key: str
    replicate: int
    timepoint: float
    raw_value: float | None
    raw_unit: str | None
    percent_of_t0: float | None
    is_excluded: bool
    exclusion_reason: str | None
    well_position: str | None


class Analyte(BaseModel):
    name: str = Field(description="the parent compound's name, or the metabolite's")
    metabolite: str | None = Field(description="the name to ask for it by; null for the parent compound")


class Measurements(BaseModel):
    arms: list[ArmInfo]
    rows: list[MeasurementRow]
    template_columns: list[str]
    stage: StageType | None = Field(
        default=None, description="the stage the saved rows were sampled in; null when there are none or they span stages"
    )
    analytes: list[Analyte] = Field(default=[], description="single endpoint: the analytes with data, the parent first")


class PastePreviewRequest(BaseModel):
    text: str
    value_kind: ValueKind = "percent_of_t0"
    metabolite: Name | None = Field(default=None, description="single endpoint: the metabolite pasted; null for the parent")


class ParsedMeasurement(BaseModel):
    arm_key: str
    replicate: int = Field(ge=1)
    timepoint: float = Field(ge=0, allow_inf_nan=False)
    raw_value: float | None = Field(default=None, allow_inf_nan=False, description="the area ratio as read")
    percent_of_t0: float | None = Field(default=None, gt=0, allow_inf_nan=False, description="time course only")


class PastePreview(BaseModel):
    columns: list[str]
    rows: list[ParsedMeasurement]
    errors: list[str]
    warnings: list[str]


class ReplaceMeasurements(BaseModel):
    rows: list[ParsedMeasurement] = Field(min_length=1)
    value_kind: ValueKind = "percent_of_t0"
    metabolite: Name | None = Field(
        default=None, description="single endpoint: the metabolite whose rows are replaced, created when new; null for the parent"
    )
    substrate_concentration: Positive | None = Field(
        default=None, description="kept from the previous rows when omitted"
    )
    substrate_concentration_unit: Name | None = None
    stage: StageType | None = Field(
        default=None,
        description="the stage the samples were taken from; when omitted, the stage of the rows being replaced, or else the last stage",
    )


class FitOut(BaseModel):
    k: float | None
    k_se: float | None
    half_life_min: float | None
    half_life_extrapolated: bool
    clint_app: float | None
    clint_app_sd: float | None
    clint_u: float | None
    r_squared: float | None
    t0_backextrapolated: float | None
    n_points: int
    n_excluded: int
    n_replicates: int
    window_min: tuple[float, float] | None
    fit_line: list[tuple[float, float]]
    problem: str | None


class InhibitionOut(BaseModel):
    percent: float
    se: float
    ci_low: float
    ci_high: float
    significant: bool
    fm_apparent: float | None
    fm_counted: bool = Field(default=False, description="whether fm_apparent is part of fm_total")
    fm_note: str | None = Field(default=None, description="why an apparent fm is not counted")


class NegativeCheckOut(BaseModel):
    percent_remaining_last: float | None
    last_time_min: float | None
    n_at_last: int
    k_ratio: float | None = Field(description="this control's rate over its stage reference's rate")
    k_ratio_se: float | None
    dependent_share: float | None = Field(description="for a minus-cofactor control, 1 - k_ratio")
    threshold_percent: float
    verdict: Verdict
    reason: str | None


class CofactorCorrectionOut(BaseModel):
    remaining_activity: float = Field(description="(k_I+/k_ref+) / (k_I-/k_ref-), display only")
    se: float | None
    twin_key: str


class PointOut(BaseModel):
    measurement_id: int
    replicate: int
    timepoint: float
    percent_of_t0: float
    excluded: bool
    exclusion_reason: str | None


class ArmResult(ArmInfo):
    points: list[PointOut]
    fit: FitOut
    inhibition: InhibitionOut | None
    negative_check: NegativeCheckOut | None = None
    cofactor_correction: CofactorCorrectionOut | None = None


class SavedRun(BaseModel):
    computed_at: dt.datetime
    computed_by: str | None


class DepletionResult(BaseModel):
    experiment_id: int
    protein_mg_per_ml: float | None
    fu_inc: float | None
    fu_inc_withheld: bool = Field(
        default=False, description="fu,inc was measured at the primary stage's protein, so no CLint,u at the sampled stage's"
    )
    arms: list[ArmResult]
    fm_total: float | None
    fm_unassigned: float | None
    problems: list[str]
    checks: list[str] = Field(default=[], description="notes that need a look but do not block the analysis")
    method: str
    saved: SavedRun | None


class Exclusion(BaseModel):
    measurement_id: int
    reason: ExclusionReason


class PreviewRequest(BaseModel):
    excluded_ids: list[int] = []


class SaveRequest(BaseModel):
    exclusions: list[Exclusion] = []


class NamedRef(BaseModel):
    id: int
    name: str


class ReagentRef(BaseModel):
    id: int
    name: str
    reagent_type: str | None
    compound: str | None


class ProtocolRef(BaseModel):
    id: int
    code: str | None
    name: str
    version: str
    study_type: str | None


class ReferenceData(BaseModel):
    compounds: list[NamedRef]
    enzymes: list[NamedRef]
    members: list[NamedRef]
    protocols: list[ProtocolRef]
    reagents: list[ReagentRef]
    reagent_lots: list[ReagentLotRow]
    tissue_lots: list[TissueLotRow]
    study_types: list[StudyType]
    reagent_types: list[ReagentType]
    pathway_roles: list[PathwayRole]
    control_types: list[ControlType]
    addition_steps: list[AdditionStep]
    component_roles: list[ComponentRole]
    experiment_statuses: list[ExperimentStatus]
    prepared_solutions: list[PreparedSolutionOut]


def _remaining_within_received(received: float | None, remaining: float | None) -> None:
    if received is not None and remaining is not None and remaining > received:
        raise ValueError("the amount remaining can't be more than the amount received")


class ReagentComponentIn(BaseModel):
    component_name: Name
    amount: NonNegative | None = None
    amount_unit: Name | None = None
    component_lot_id: int | None = None

    @model_validator(mode="after")
    def _unit(self) -> Self:
        if self.amount is not None and self.amount_unit is None:
            raise ValueError("a component's amount needs its unit")
        return self


class ReagentLotIn(BaseModel):
    reagent_name: Name
    reagent_type: ReagentType | None = None
    compound_name: Name | None = None
    vendor: Name | None = None
    catalog_number: Name | None = None
    lot_number: Name
    concentration: NonNegative | None = None
    concentration_unit: Name | None = None
    received_date: dt.date | None = None
    expiry_date: dt.date | None = None
    storage_temp_c: Finite | None = None
    quantity_received: NonNegative | None = None
    quantity_remaining: NonNegative | None = None
    quantity_unit: Name | None = None
    notes: Note | None = None
    components: list[ReagentComponentIn] = Field(
        default=[], max_length=12, description="what this lot of a regenerating system holds, and the lots it was made from"
    )

    @model_validator(mode="after")
    def _amounts(self) -> Self:
        _remaining_within_received(self.quantity_received, self.quantity_remaining)
        if self.components and self.reagent_type not in (None, "regenerating_system"):
            raise ValueError("only a regenerating system lists components")
        return self


MaterialType = Literal["HLM", "S9", "cytosol", "hepatocytes", "intestinal_microsomes", "liver_tissue"]


class TissueLotIn(BaseModel):
    material_type: MaterialType
    species: Name = "human"
    pooled_or_individual: Literal["pooled", "individual"] | None = None
    number_of_donors: int | None = Field(default=None, ge=1)
    vendor_or_source: Name | None = None
    catalog_number: Name | None = None
    lot_number: Name
    protein_concentration: NonNegative | None = Field(default=None, description="in mg/mL")
    viability: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None
    received_date: dt.date | None = None
    expiry_date: dt.date | None = None
    storage_temp_c: Finite | None = None
    quantity_remaining: NonNegative | None = None
    quantity_unit: Name | None = None
    notes: Note | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.viability is not None and self.material_type != "hepatocytes":
            raise ValueError("only hepatocytes have a viability")
        if self.pooled_or_individual == "individual" and self.number_of_donors not in (None, 1):
            raise ValueError("an individual lot comes from one donor")
        return self


class TissueLotUpdate(BaseModel):
    """Maintain a tissue lot's stock and storage record; omitted fields stay unchanged."""

    catalog_number: Name | None = None
    expiry_date: dt.date | None = None
    storage_temp_c: Finite | None = None
    quantity_remaining: NonNegative | None = None
    quantity_unit: Name | None = None
    is_depleted: bool | None = None
    notes: Note | None = None

    @model_validator(mode="after")
    def _depleted_stays_boolean(self) -> Self:
        if "is_depleted" in self.model_fields_set and self.is_depleted is None:
            raise ValueError("is_depleted can't be cleared")
        return self


class ReagentLotUpdate(BaseModel):
    """Only the fields sent change; send null to clear one."""

    lot_number: Name | None = None
    vendor: Name | None = None
    catalog_number: Name | None = None
    concentration: NonNegative | None = None
    concentration_unit: Name | None = None
    received_date: dt.date | None = None
    expiry_date: dt.date | None = None
    storage_temp_c: Finite | None = None
    quantity_received: NonNegative | None = None
    quantity_remaining: NonNegative | None = None
    quantity_unit: Name | None = None
    is_depleted: bool | None = None
    notes: Note | None = None
    compound_name: Name | None = Field(
        default=None, description="links the lot's reagent to its compound, when the reagent has none yet"
    )

    @model_validator(mode="after")
    def _required_and_amounts(self) -> Self:
        for field in ("lot_number", "is_depleted"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} can't be cleared")
        _remaining_within_received(self.quantity_received, self.quantity_remaining)
        return self


class ConditionIn(BaseModel):
    protein_concentration: NonNegative | None = None
    cell_density: NonNegative | None = None
    cell_density_unit: Name | None = None
    incubation_temperature: Finite | None = 37
    incubation_time: NonNegative | None = None
    preincubation_time: NonNegative | None = None
    buffer: Name | None = None
    ph: float | None = Field(default=None, ge=0, le=14, allow_inf_nan=False)
    solvent: Name | None = None
    solvent_percentage: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    fu_inc: float | None = Field(default=None, gt=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def _preincubation_fits(self) -> Self:
        if self.preincubation_time is not None and self.incubation_time is not None:
            if self.preincubation_time > self.incubation_time:
                raise ValueError("preincubation can't be longer than the incubation")
        return self


class PreparedSolutionIn(BaseModel):
    label: Name
    prepared_by: int | None = None
    prepared_on: dt.date | None = None
    buffer_composition: Note | None = None
    notes: Note | None = None


class PreparedSolutionUpdate(BaseModel):
    """Only the fields sent change. A preparer or a date left out at creation can be recorded later."""

    prepared_by: int | None = None
    prepared_on: dt.date | None = None
    buffer_composition: Note | None = None
    notes: Note | None = None


class CofactorIn(BaseModel):
    """One component of the incubation. Its role says what it is for; a minus-cofactor control can leave out
    only a component whose role is cofactor."""

    cofactor: Name
    role: ComponentRole | None = Field(default=None, description="no default: an unclassified component stays null")
    concentration: NonNegative | None = None
    concentration_unit: Name | None = None
    reagent_lot_id: int | None = None
    prepared_solution_id: int | None = Field(default=None, description="an existing prepared solution it came from")
    solution: PreparedSolutionIn | None = Field(default=None, description="a prepared solution to record with it")

    @model_validator(mode="after")
    def _one_solution(self) -> Self:
        if self.prepared_solution_id is not None and self.solution is not None:
            raise ValueError("a component comes from one prepared solution: name an existing one or describe a new one")
        return self


class ArmIn(BaseModel):
    inhibitor: Name
    role: ModulatorRole = "inhibitor"
    target_enzyme: Name | None = None
    also_targets: list[Name] = Field(default=[], max_length=4, description="further enzymes the inhibitor blocks, in order")
    concentration: Positive | None = None
    concentration_unit: Name = "uM"
    reagent_lot_id: int | None = None
    stage: StageType = "primary"
    arm_label: Name | None = None
    solvent: Name | None = Field(default=None, description="'none' means aqueous; empty inherits the condition's solvent")
    solvent_percentage: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    cofactor_omitted: bool = False
    omitted_cofactor: int | None = Field(
        default=None, ge=0, description="index into cofactors; with cofactor_omitted and empty, every cofactor is omitted"
    )
    reference_control: int | None = Field(default=None, ge=0, description="index into controls; resolved by solvent when empty")
    incubation_minutes: NonNegative | None = Field(default=None, description="its time in its stage; empty means the stage's")
    replicates: Replicates = Field(default=3, description="the wells planned for it in a single-endpoint experiment")

    @model_validator(mode="after")
    def _omission(self) -> Self:
        if self.omitted_cofactor is not None and not self.cofactor_omitted:
            raise ValueError("an arm can name an omitted cofactor only when its cofactor is omitted")
        return self

    @model_validator(mode="after")
    def _targets_differ(self) -> Self:
        if self.also_targets and self.target_enzyme is None:
            raise ValueError("an arm can name further targets only after its target enzyme")
        seen = {self.target_enzyme.lower()} if self.target_enzyme else set()
        for name in self.also_targets:
            if name.lower() in seen:
                raise ValueError(f"an arm names {name} as a target more than once")
            seen.add(name.lower())
        return self


class ControlIn(BaseModel):
    stage: StageType = "primary"
    control_type: ControlType
    label: Name | None = Field(default=None, description="derived from the type when omitted, except for other")
    solvent: Name | None = None
    solvent_percentage: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    omitted_cofactor: int | None = Field(default=None, ge=0, description="index into cofactors; minus_cofactor only; empty means all")
    protein_concentration: NonNegative | None = Field(default=None, description="heat_inactivated and other only")
    notes: Note | None = None
    incubation_minutes: NonNegative | None = Field(default=None, description="its time in its stage; empty means the stage's")
    replicates: Replicates = Field(default=3, description="the wells planned for it in a single-endpoint experiment")

    @model_validator(mode="after")
    def _shape(self) -> Self:
        if self.control_type == "other" and self.label is None:
            raise ValueError("a control of type other needs a label")
        if self.omitted_cofactor is not None and self.control_type != "minus_cofactor":
            raise ValueError("only a minus-cofactor control can name an omitted cofactor")
        if self.control_type == "complete" and (self.solvent is not None or self.solvent_percentage is not None):
            raise ValueError("a complete incubation has no added solvent")
        if self.control_type == "vehicle" and self.solvent is not None and self.solvent.lower() == "none":
            raise ValueError("a control with no solvent added is a complete incubation, not a vehicle")
        if self.protein_concentration is not None and self.control_type not in ("heat_inactivated", "other"):
            raise ValueError("only heat-inactivated and other controls can set their own protein level")
        return self


class InternalStandardIn(BaseModel):
    compound: Name
    concentration: Positive | None = None
    concentration_unit: Name | None = None
    addition_step: AdditionStep = "reaction_termination"
    solvent: Name | None = "ice-cold acetonitrile"
    reagent_lot_id: int | None = None
    notes: Note | None = None

    @model_validator(mode="after")
    def _unit(self) -> Self:
        if self.concentration is not None and self.concentration_unit is None:
            raise ValueError("the internal standard's concentration needs its unit")
        return self


class StatusChange(BaseModel):
    status: ExperimentStatus


class StatusChanged(BaseModel):
    status: ExperimentStatus
    warnings: list[str] = Field(description="what the record still lacks for this status; the change is saved regardless")


class StageIn(BaseModel):
    stage_type: StageType
    incubation_minutes: NonNegative | None = None
    protein_concentration: NonNegative | None = None
    cell_density: NonNegative | None = None
    cell_density_unit: Name | None = None
    dilution_factor: Positive | None = None
    diluted_from: StageType | None = None
    notes: Note | None = None

    @model_validator(mode="after")
    def _dilution_pair(self) -> Self:
        if (self.dilution_factor is None) != (self.diluted_from is None):
            raise ValueError("a dilution needs both its factor and the stage it was diluted from")
        return self


class PathwayIn(BaseModel):
    enzyme: Name
    pathway_role: PathwayRole
    organ_context: OrganContext = "hepatic"


class ExperimentDetailsUpdate(BaseModel):
    """The fields an experiment keeps editable after bench data exists. Only the fields sent change."""

    title: Name | None = None
    objective: Note | None = None
    experiment_date: dt.date | None = None
    performed_by: int | None = None

    @model_validator(mode="after")
    def _title_stays(self) -> Self:
        if "title" in self.model_fields_set and self.title is None:
            raise ValueError("an experiment keeps its title")
        return self


class ExperimentIn(BaseModel):
    code: Name | None = Field(default=None, description="generated as WL-<year>-<n> when omitted")
    title: Name
    study_type: StudyType
    experiment_date: dt.date | None = None
    performed_by: int | None = Field(default=None, description="defaults to the signed-in lab member")
    protocol_id: int | None = None
    substrate: Name
    substrate_reagent_lot_id: int | None = None
    tissue_lot_id: int | None = None
    objective: Note | None = None
    sampling: Sampling = Field(default="time_course", description="endpoint: each condition is read once, at the end of the last stage")
    condition: ConditionIn = ConditionIn()
    cofactors: list[CofactorIn] = Field(default=[], max_length=6)
    arms: list[ArmIn] = Field(default=[], max_length=48)
    controls: list[ControlIn] | None = Field(
        default=None, max_length=16, description="one Vehicle control per stage when omitted; an empty list means none"
    )
    pathways: list[PathwayIn] = Field(default=[], max_length=12)
    internal_standard: InternalStandardIn | None = None
    stages: list[StageIn] | None = Field(
        default=None, min_length=1, max_length=3, description="one primary stage built from the condition when omitted"
    )

    @model_validator(mode="after")
    def _stages_in_order(self) -> Self:
        if self.stages is None:
            return self
        given = [name for name in ("incubation_time", "protein_concentration", "cell_density", "cell_density_unit") if getattr(self.condition, name) is not None]
        if given:
            raise ValueError("with stages, give incubation time, protein and cell density on the stages, not on the condition")
        types = [stage.stage_type for stage in self.stages]
        if types != list(STAGE_ORDER[: len(types)]):
            raise ValueError("stages must run primary, then secondary, then tertiary")
        for index, stage in enumerate(self.stages):
            if stage.diluted_from is not None and stage.diluted_from not in types[:index]:
                raise ValueError(f"the {stage.stage_type} stage can only be diluted from a stage before it")
        primary = self.stages[0].incubation_minutes
        preincubation = self.condition.preincubation_time
        if primary is not None and preincubation is not None and preincubation > primary:
            raise ValueError("preincubation can't be longer than the primary incubation")
        return self

    @model_validator(mode="after")
    def _internal_standard_stands_alone(self) -> Self:
        if self.internal_standard is None:
            return self
        name = self.internal_standard.compound.lower()
        if name == self.substrate.lower():
            raise ValueError("the internal standard can't be the substrate")
        if any(arm.inhibitor.lower() == name for arm in self.arms):
            raise ValueError(f"{self.internal_standard.compound} is an arm's inhibitor, so it can't also be the internal standard")
        return self

    @model_validator(mode="after")
    def _control_labels_differ(self) -> Self:
        seen: set[tuple[str, str]] = set()
        for control in self.controls or []:
            if control.label is None:
                continue
            key = (control.stage, control.label.strip().lower())
            if key in seen:
                raise ValueError(f"two controls in the {control.stage} stage share the label {control.label}")
            seen.add(key)
        return self

    @model_validator(mode="after")
    def _references_exist(self) -> Self:
        stages = [stage.stage_type for stage in self.stages] if self.stages else ["primary"]
        controls = self.controls or []
        for kind, items in (("arm", self.arms), ("control", controls)):
            for index, item in enumerate(items, start=1):
                if item.stage not in stages:
                    raise ValueError(f"{kind} {index} names the {item.stage} stage, which this experiment does not have")
                if item.omitted_cofactor is not None and item.omitted_cofactor >= len(self.cofactors):
                    raise ValueError(f"{kind} {index} omits cofactor {item.omitted_cofactor + 1}, which is not listed")
                if item.omitted_cofactor is not None and self.cofactors[item.omitted_cofactor].role != "cofactor":
                    name = self.cofactors[item.omitted_cofactor].cofactor
                    raise ValueError(f"{kind} {index} leaves out {name}, which is not listed with the cofactor role")
        for index, arm in enumerate(self.arms, start=1):
            if arm.reference_control is None:
                continue
            if arm.reference_control >= len(controls):
                raise ValueError(f"arm {index} names control {arm.reference_control + 1}, which is not listed")
            reference = controls[arm.reference_control]
            if reference.stage != arm.stage:
                raise ValueError(f"arm {index}'s reference control must be in the arm's own stage")
            if arm.cofactor_omitted:
                if reference.control_type != "minus_cofactor" or reference.omitted_cofactor != arm.omitted_cofactor:
                    raise ValueError(f"arm {index} omits a cofactor, so its reference must be a control omitting the same one")
            elif reference.control_type not in ("vehicle", "complete"):
                raise ValueError(f"arm {index}'s reference must be a vehicle or a complete incubation")
        return self
