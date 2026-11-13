import type { Schemas } from "@/api/client";
import {
  COMPONENT_UNITS,
  INTERNAL_STANDARD_UNITS,
  LOT_TYPES_FOR_ROLE,
  isReferenceType,
  solventText,
  type AdditionStep,
  type ArmRole,
  type ComponentRole,
  type ControlType,
  type PathwayRole,
  type Sampling,
  type StudyType,
} from "@/lib/domain";
import { draftReader, sameName, type Parsed } from "@/lib/drafts";

type Lot = Schemas["ReagentLotRow"];
type ArmIn = Schemas["ArmIn"];

export const CELL_DENSITY_UNIT = "10^6 cells/mL";
/** The API's caps. Arm rows count every concentration, and every run without cofactor, as a row of its own. */
export const MAX_ROWS = { cofactors: 6, armRows: 48, controls: 16, pathways: 12, stages: 3, alsoTargets: 4 } as const;

export type StageType = Schemas["StageIn"]["stage_type"];
/** The replicate wells a condition plans when nothing else is typed, as the API defaults them. */
export const DEFAULT_REPLICATES = "3";
const MAX_REPLICATES = 12;
const STAGE_TYPES: readonly StageType[] = ["primary", "secondary", "tertiary"];

/** A stage's type follows its position: the first is primary, then secondary, then tertiary. */
export function stageType(index: number): StageType {
  const type = STAGE_TYPES[index];
  if (type === undefined) throw new Error(`An experiment holds at most ${STAGE_TYPES.length} stages.`);
  return type;
}

/** An omitted cofactor is a cofactor row's key, or this for every cofactor at once. */
export const EVERY_COFACTOR = "every";
/** An arm's solvent: empty to share the incubation's, the API's "none" for no solvent, a vehicle row's
 * solvent by that row's key, or one typed in. */
export const NO_SOLVENT = "none";
export const TYPED_SOLVENT = "typed";
const VEHICLE_SOLVENT = "vehicle:";

export function vehicleSolvent(controlKey: number): string {
  return `${VEHICLE_SOLVENT}${controlKey}`;
}

/** Each repeatable row carries a key of its own so React keeps its inputs when an earlier row is removed. */
/** A prepared solution recorded with the component that came from it. */
export type SolutionDraft = { label: string; prepared_by: string; prepared_on: string; buffer_composition: string };
/** One component of the incubation besides the substrate and enzyme source (the API still calls them cofactors).
 * Its role has no default, so nothing becomes a cofactor by accident. Its solution is empty for none, NEW_SOLUTION
 * for one described here, or an existing solution's id. */
export type CofactorDraft = {
  key: number;
  cofactor: string;
  role: ComponentRole | "";
  concentration: string;
  concentration_unit: (typeof COMPONENT_UNITS)[number];
  reagent_lot_id: string;
  solution: string;
  new_solution: SolutionDraft;
};
export const NEW_SOLUTION = "new";
/** A control belongs to a stage by the stage row's key. Its label may stay empty: the API then derives one. */
export type ControlDraft = {
  key: number;
  stage: number;
  control_type: ControlType;
  label: string;
  solvent: string;
  solvent_percentage: string;
  omitted_cofactor: string;
  protein_concentration: string;
  incubation_minutes: string;
  replicates: string;
};
export type ConcentrationDraft = { key: number; concentration: string };
export type TargetDraft = { key: number; enzyme: string };
/** One inhibitor in one stage, at one or more concentrations. It becomes one API arm per concentration,
 * plus one more per concentration when it also runs without a cofactor. Every one runs for the series' time in
 * the stage; the runs without cofactor plan replicates of their own. */
export type ArmDraft = {
  key: number;
  inhibitor: string;
  role: ArmRole;
  target_enzyme: string;
  also_targets: TargetDraft[];
  reagent_lot_id: string;
  stage: number;
  solvent: string;
  typed_solvent: string;
  solvent_percentage: string;
  concentrations: ConcentrationDraft[];
  without_cofactor: boolean;
  omitted_cofactor: string;
  reference_control: string;
  twin_reference_control: string;
  incubation_minutes: string;
  replicates: string;
  twin_replicates: string;
};
export type PathwayDraft = { key: number; enzyme: string; pathway_role: PathwayRole };
/** Left without a compound, the experiment has no internal standard. */
export type InternalStandardDraft = {
  compound: string;
  concentration: string;
  concentration_unit: (typeof INTERNAL_STANDARD_UNITS)[number];
  addition_step: AdditionStep;
  solvent: string;
  reagent_lot_id: string;
};
/** One incubation. Every stage after the first can start as a dilution of the stage before it. */
export type StageDraft = {
  key: number;
  incubation_minutes: string;
  protein_concentration: string;
  cell_density: string;
  dilution_factor: string;
};

export type ConditionDraft = {
  incubation_temperature: string;
  preincubation_time: string;
  buffer: string;
  ph: string;
  solvent: string;
  solvent_percentage: string;
  fu_inc: string;
};

/** The form as typed, keyed like `ExperimentIn`, so a field's path is also where the API reports it.
 * Arms are the exception: one arm here is a concentration series there. */
export type ExperimentDraft = {
  title: string;
  study_type: StudyType | "";
  experiment_date: string;
  performed_by: string;
  protocol_id: string;
  code: string;
  objective: string;
  substrate: string;
  substrate_reagent_lot_id: string;
  tissue_lot_id: string;
  sampling: Sampling;
  condition: ConditionDraft;
  stages: StageDraft[];
  controls: ControlDraft[];
  cofactors: CofactorDraft[];
  arms: ArmDraft[];
  pathways: PathwayDraft[];
  internal_standard: InternalStandardDraft;
};

let lastKey = 0;
export function rowKey(): number {
  lastKey += 1;
  return lastKey;
}

export function isHepatocyteStudy(studyType: StudyType | ""): boolean {
  return studyType === "hepatocyte_stability";
}

export function isUsable(lot: Lot): boolean {
  return !lot.flags.includes("depleted") && !lot.flags.includes("expired");
}

/** A lot is "of" a compound when its reagent or that reagent's compound has the compound's name. */
export function isLotOf(lot: Lot, name: string): boolean {
  return sameName(lot.reagent, name) || sameName(lot.compound, name);
}

/** The lots that fit a component of a role: cofactor and regenerating-system lots for a cofactor, and so on. */
export function lotsForRole(lots: readonly Lot[], role: ComponentRole | ""): Lot[] {
  const types = role ? LOT_TYPES_FOR_ROLE[role] : null;
  return types ? lots.filter((lot) => types.some((type) => type === lot.reagent_type)) : [...lots];
}

/** The components a minus-cofactor control or a run without cofactor can leave out. */
export function omittableCofactors(draft: ExperimentDraft): CofactorDraft[] {
  return draft.cofactors.filter((row) => row.role === "cofactor" && row.cofactor.trim());
}

export function blankExperiment({ memberId }: { memberId: number | null }): ExperimentDraft {
  const primary = blankStage();
  return {
    title: "",
    study_type: "",
    experiment_date: "",
    performed_by: memberId === null ? "" : String(memberId),
    protocol_id: "",
    code: "",
    objective: "",
    substrate: "",
    substrate_reagent_lot_id: "",
    tissue_lot_id: "",
    sampling: "time_course",
    condition: {
      incubation_temperature: "37",
      preincubation_time: "",
      buffer: "",
      ph: "",
      solvent: "",
      solvent_percentage: "",
      fu_inc: "",
    },
    stages: [primary],
    controls: [blankControl(primary.key)],
    cofactors: [],
    arms: [],
    pathways: [],
    internal_standard: {
      compound: "",
      concentration: "",
      concentration_unit: "nM",
      addition_step: "reaction_termination",
      solvent: "ice-cold acetonitrile",
      reagent_lot_id: "",
    },
  };
}

export function blankConcentration(): ConcentrationDraft {
  return { key: rowKey(), concentration: "" };
}

export function blankTarget(): TargetDraft {
  return { key: rowKey(), enzyme: "" };
}

export function blankArm(studyType: StudyType | "", stage: number): ArmDraft {
  return {
    key: rowKey(),
    inhibitor: "",
    role: studyType === "antibody_inhibition" ? "antibody_inhibitor" : "inhibitor",
    target_enzyme: "",
    also_targets: [],
    reagent_lot_id: "",
    stage,
    solvent: "",
    typed_solvent: "",
    solvent_percentage: "",
    concentrations: [blankConcentration()],
    without_cofactor: false,
    omitted_cofactor: "",
    reference_control: "",
    twin_reference_control: "",
    incubation_minutes: "",
    replicates: DEFAULT_REPLICATES,
    twin_replicates: DEFAULT_REPLICATES,
  };
}

export function blankControl(stage: number, controlType: ControlType = "vehicle"): ControlDraft {
  return {
    key: rowKey(),
    stage,
    control_type: controlType,
    label: "",
    solvent: "",
    solvent_percentage: "",
    omitted_cofactor: EVERY_COFACTOR,
    protein_concentration: "",
    incubation_minutes: "",
    replicates: DEFAULT_REPLICATES,
  };
}

export function blankCofactor(): CofactorDraft {
  return {
    key: rowKey(),
    cofactor: "",
    role: "",
    concentration: "",
    concentration_unit: "mM",
    reagent_lot_id: "",
    solution: "",
    new_solution: { label: "", prepared_by: "", prepared_on: "", buffer_composition: "" },
  };
}

export function blankPathway(): PathwayDraft {
  return { key: rowKey(), enzyme: "", pathway_role: "major" };
}

export function blankStage(): StageDraft {
  return { key: rowKey(), incubation_minutes: "", protein_concentration: "", cell_density: "", dilution_factor: "" };
}

function typedNumber(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(value) ? value : null;
}

/** The protein concentration a dilution implies, while both numbers are typed in. */
export function expectedProtein(previousProtein: string, dilutionFactor: string): number | null {
  const protein = typedNumber(previousProtein);
  const factor = typedNumber(dilutionFactor);
  return protein !== null && factor !== null && factor > 0 ? protein / factor : null;
}

/** How many API arm rows the arms make: one per concentration, doubled for an arm also run without cofactor. */
export function armRowCount(arms: readonly ArmDraft[]): number {
  return arms.reduce((total, arm) => total + arm.concentrations.length * (arm.without_cofactor ? 2 : 1), 0);
}

/** Python's "{:g}", which the API uses when it writes a number into a label: six significant digits, trailing
 * zeros dropped, and exponent form below 1e-4 or from 1e6 up, as in 1e-05 and 1.5e+06. */
export function g(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(6));
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent >= -4 && exponent < 6) return String(rounded);
  const [mantissa = "", power = "0"] = rounded.toExponential(5).split("e");
  const digits = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
  const exp = Number(power);
  return `${digits}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

function baseLabel(control: ControlDraft, cofactors: readonly CofactorDraft[], hepatocytes: boolean): string | null {
  switch (control.control_type) {
    case "vehicle":
      return "Vehicle control";
    case "complete":
      return "Complete incubation";
    case "minus_substrate":
      return "Minus substrate";
    case "minus_protein":
      return hepatocytes ? "No cells" : "Minus protein";
    case "heat_inactivated": {
      const protein = typedNumber(control.protein_concentration);
      return protein === null ? "Heat-inactivated" : `Heat-inactivated ${g(protein)} mg/mL`;
    }
    case "minus_cofactor": {
      const omitted = cofactors.find((row) => String(row.key) === control.omitted_cofactor)?.cofactor.trim();
      if (omitted) return `Minus ${omitted}`;
      return cofactors.some((row) => row.cofactor.trim()) ? "Minus all cofactors" : "Minus cofactor";
    }
    case "other":
      return null;
  }
}

/** The label the API gives each control left without one, by control key; the same rules as
 * `_derived_labels` in the backend. A derived label names the solvent when its stage holds another control
 * of its type in a different solvent, and is numbered when it would repeat a label already taken. */
export function derivedControlLabels(draft: ExperimentDraft): ReadonlyMap<number, string> {
  const hepatocytes = isHepatocyteStudy(draft.study_type);
  const cofactors = omittableCofactors(draft);
  const labels = new Map<number, string>();
  for (const stage of draft.stages) {
    const inStage = draft.controls.filter((control) => control.stage === stage.key);
    const taken = new Set(inStage.map((control) => control.label.trim().toLowerCase()).filter(Boolean));
    for (const control of inStage) {
      if (control.label.trim()) continue;
      let base = baseLabel(control, cofactors, hepatocytes);
      if (base === null) continue;
      const solvent = control.control_type === "complete" ? "" : control.solvent.trim();
      const solvents = new Set(
        inStage
          .filter((other) => other.control_type === control.control_type)
          .map((other) => (other.control_type === "complete" ? "" : other.solvent.trim().toLowerCase())),
      );
      if (solvents.size > 1 && solvent) {
        const percentage = typedNumber(control.solvent_percentage);
        base = `${base} (${solvent}${percentage !== null ? ` ${g(percentage)}%` : ""})`;
      }
      let label = base;
      for (let number = 2; taken.has(label.toLowerCase()); number += 1) label = `${base} ${number}`;
      taken.add(label.toLowerCase());
      labels.set(control.key, label);
    }
  }
  return labels;
}

/** A control's label as typed, or else the one the API will give it. */
export function controlLabel(control: ControlDraft, derived: ReadonlyMap<number, string>): string {
  return control.label.trim() || derived.get(control.key) || "Unlabelled control";
}

/** The vehicles in a stage whose solvent an arm in that stage can choose, each named, so two vehicles at the same
 * solvent and percentage stay distinct choices. */
export function vehicleSolventChoices(
  draft: ExperimentDraft,
  stage: number,
  derived: ReadonlyMap<number, string>,
): { value: string; label: string }[] {
  return draft.controls.flatMap((control) => {
    const solvent = control.solvent.trim();
    if (control.stage !== stage || control.control_type !== "vehicle" || !solvent) return [];
    const text = solventText(solvent, typedNumber(control.solvent_percentage)) ?? solvent;
    return [{ value: vehicleSolvent(control.key), label: `${text}, as ${controlLabel(control, derived)}` }];
  });
}

/** The controls in a stage that an arm there can be compared against. */
export function referenceChoices(draft: ExperimentDraft, stage: number): ControlDraft[] {
  return draft.controls.filter((control) => control.stage === stage && isReferenceType(control.control_type));
}

/** The controls in a stage that an arm's runs without a cofactor can be compared against: those leaving out the
 * same cofactor, or every cofactor. */
export function twinReferenceChoices(draft: ExperimentDraft, stage: number, omitted: string): ControlDraft[] {
  return draft.controls.filter(
    (control) => control.stage === stage && control.control_type === "minus_cofactor" && control.omitted_cofactor === omitted,
  );
}

/** The components a control or a run without cofactor can leave out, by key. */
export function omittableKeys(draft: ExperimentDraft): string[] {
  return omittableCofactors(draft).map((row) => String(row.key));
}

/** Where each arm row the API receives came from in the form: the arm, and its concentration. The API reports a
 * problem by its row, and this puts that problem back on the field it belongs to. */
export function armRowOrigins(draft: ExperimentDraft): { arm: number; concentration: number }[] {
  return draft.arms.flatMap((arm, index) => {
    const rows = arm.concentrations.map((_, at) => ({ arm: index, concentration: at }));
    return arm.without_cofactor ? [...rows, ...rows] : rows;
  });
}

/** An API problem path on an arm row, moved to the matching field of the form's arm. */
export function formArmPath(path: string, origins: readonly { arm: number; concentration: number }[]): string {
  const match = /^arms\.(\d+)\.(.+)$/.exec(path);
  const origin = match ? origins[Number(match[1])] : undefined;
  if (!match || !origin) return path;
  const field = match[2] ?? "";
  if (field === "concentration") return `arms.${origin.arm}.concentrations.${origin.concentration}.concentration`;
  if (/^also_targets\.\d+$/.test(field)) return `arms.${origin.arm}.${field}.enzyme`;
  return `arms.${origin.arm}.${field}`;
}

export function experimentBody(draft: ExperimentDraft, lots: readonly Lot[] = []): Parsed<Schemas["ExperimentIn"]> {
  const read = draftReader();
  /** A picked lot whose reagent names another compound is refused here, as the API would refuse it. Its reagent's
   * own name counts as a match too, as it does when the lot picker lists it. */
  const checkLot = (path: string, lotId: string, name: string) => {
    const lot = lots.find((candidate) => String(candidate.id) === lotId);
    if (lot?.compound && name.trim() && !sameName(lot.compound, name) && !sameName(lot.reagent, name)) {
      read.fail(path, `${lot.lot_number} is a lot of ${lot.compound}, not ${name.trim()}.`);
    }
  };
  checkLot("substrate_reagent_lot_id", draft.substrate_reagent_lot_id, draft.substrate);
  draft.arms.forEach((arm, index) => checkLot(`arms.${index}.reagent_lot_id`, arm.reagent_lot_id, arm.inhibitor));
  checkLot("internal_standard.reagent_lot_id", draft.internal_standard.reagent_lot_id, draft.internal_standard.compound);
  const hepatocytes = isHepatocyteStudy(draft.study_type);
  if (draft.study_type === "") read.fail("study_type", "Choose a study type.");

  const c = draft.condition;
  const stages = draft.stages.map((row, index) => {
    const cellDensity = hepatocytes ? read.number(`stages.${index}.cell_density`, row.cell_density) : null;
    const dilution = index === 0 ? null : read.number(`stages.${index}.dilution_factor`, row.dilution_factor);
    return {
      stage_type: stageType(index),
      incubation_minutes: read.number(`stages.${index}.incubation_minutes`, row.incubation_minutes),
      protein_concentration: hepatocytes ? null : read.number(`stages.${index}.protein_concentration`, row.protein_concentration),
      cell_density: cellDensity,
      cell_density_unit: cellDensity === null ? null : CELL_DENSITY_UNIT,
      dilution_factor: dilution,
      diluted_from: dilution === null ? null : stageType(index - 1),
    };
  });
  const primaryMinutes = stages[0]?.incubation_minutes ?? null;
  const preincubation = read.number("condition.preincubation_time", c.preincubation_time);
  if (primaryMinutes !== null && preincubation !== null && preincubation > primaryMinutes) {
    read.fail("condition.preincubation_time", "Can't be longer than the primary incubation.");
  }

  const stageOf = new Map(draft.stages.map((row, index) => [row.key, stageType(index)]));
  const omittable = new Set(omittableKeys(draft));
  const cofactorIndex = new Map(draft.cofactors.map((row, index) => [String(row.key), index]));
  const controlIndex = new Map(draft.controls.map((row, index) => [String(row.key), index]));
  const stageFor = (path: string, key: number): StageType => {
    const stage = stageOf.get(key);
    if (stage === undefined) read.fail(path, "Choose the stage again.");
    return stage ?? "primary";
  };
  /** The cofactor a control or twin leaves out, as the API's index, or null for every cofactor. A choice whose
   * component was removed or renamed away is refused here rather than quietly replaced. */
  const omittedCofactor = (path: string, value: string): number | null => {
    if (value === EVERY_COFACTOR) return null;
    const index = omittable.has(value) ? cofactorIndex.get(value) : undefined;
    if (index === undefined) read.fail(path, "Choose which cofactor it leaves out.");
    return index ?? null;
  };
  const minutesIn = (path: string, raw: string): number | null => {
    const value = read.number(path, raw);
    if (value !== null && value < 0) read.fail(path, "Can't be negative.");
    return value;
  };
  /** Replicates count only for a single endpoint. A time course hides the field, so what it holds is sent when it
   * reads as a count and the default otherwise. */
  const replicatesOf = (path: string, raw: string): number => {
    const value = typedNumber(raw);
    if (value !== null && Number.isInteger(value) && value >= 1 && value <= MAX_REPLICATES) return value;
    if (draft.sampling === "endpoint") read.fail(path, raw.trim() ? `A whole number from 1 to ${MAX_REPLICATES}.` : "Required.");
    return Number(DEFAULT_REPLICATES);
  };
  /** A chosen control, as the API's index, when it is still in the stage and still of a fitting type. */
  const chosenControl = (path: string, value: string, stage: number, fits: (control: ControlDraft) => boolean): number | null => {
    if (!value) return null;
    const control = draft.controls.find((candidate) => String(candidate.key) === value);
    if (!control || control.stage !== stage || !fits(control)) {
      read.fail(path, "Choose the control again: the one chosen has changed.");
      return null;
    }
    return controlIndex.get(value) ?? null;
  };

  const givenLabels = new Map<string, string>();
  const controls = draft.controls.map((row, index) => {
    const path = `controls.${index}`;
    const type = row.control_type;
    const label = read.text(`${path}.label`, row.label, { required: type === "other" });
    if (label) {
      const identity = `${row.stage}|${label.toLowerCase()}`;
      if (givenLabels.has(identity)) read.fail(`${path}.label`, "Another control in this stage has this label.");
      givenLabels.set(identity, label);
    }
    const solvent = type === "complete" ? null : read.text(`${path}.solvent`, row.solvent);
    if (type === "vehicle" && solvent?.toLowerCase() === NO_SOLVENT) {
      read.fail(`${path}.solvent`, "With no solvent added, choose the complete incubation type instead.");
    }
    const typedPercentage = type === "complete" ? null : read.number(`${path}.solvent_percentage`, row.solvent_percentage);
    if (typedPercentage !== null && !solvent) read.fail(`${path}.solvent`, "Name the solvent this percentage is of.");
    const percentage = solvent ? typedPercentage : null;
    if (percentage !== null && (percentage < 0 || percentage > 100)) read.fail(`${path}.solvent_percentage`, "Between 0 and 100.");
    // A hepatocyte study hides the protein field, so whatever it held is not sent.
    const ownProtein = !hepatocytes && (type === "heat_inactivated" || type === "other");
    return {
      stage: stageFor(`${path}.control_type`, row.stage),
      control_type: type,
      label,
      solvent,
      solvent_percentage: percentage,
      omitted_cofactor: type === "minus_cofactor" ? omittedCofactor(`${path}.omitted_cofactor`, row.omitted_cofactor) : null,
      protein_concentration: ownProtein ? read.number(`${path}.protein_concentration`, row.protein_concentration) : null,
      incubation_minutes: minutesIn(`${path}.incubation_minutes`, row.incubation_minutes),
      replicates: replicatesOf(`${path}.replicates`, row.replicates),
    };
  });

  const armNames = new Set<string>();
  const arms = draft.arms.flatMap((row, index): ArmIn[] => {
    const path = `arms.${index}`;
    const identity = `${row.stage}|${row.inhibitor.trim().toLowerCase()}`;
    if (row.inhibitor.trim() && armNames.has(identity)) {
      read.fail(`${path}.inhibitor`, "Already an arm in this stage. Add the concentration to that arm instead.");
    }
    armNames.add(identity);
    const solvent = armSolvent(draft, row, path, read);
    const seen = new Set<string>();
    const concentrations = row.concentrations.map((entry, at) => {
      const field = `${path}.concentrations.${at}.concentration`;
      const value = read.number(field, entry.concentration);
      if (value !== null && value <= 0) read.fail(field, "Must be more than 0.");
      if (seen.has(String(value))) read.fail(field, value === null ? "Only one concentration can be left empty." : "Already listed.");
      seen.add(String(value));
      return value;
    });
    const target = read.text(`${path}.target_enzyme`, row.target_enzyme);
    if (target === null && row.also_targets.length > 0) {
      read.fail(`${path}.target_enzyme`, "Name the target enzyme, or remove the other targets.");
    }
    const targets = target === null ? [] : [target];
    const alsoTargets = row.also_targets.map((entry, at) => {
      const field = `${path}.also_targets.${at}.enzyme`;
      const enzyme = read.text(field, entry.enzyme, { required: true }) ?? "";
      if (enzyme && targets.some((named) => sameName(named, enzyme))) read.fail(field, "Already a target.");
      targets.push(enzyme);
      return enzyme;
    });
    const base = {
      inhibitor: read.text(`${path}.inhibitor`, row.inhibitor, { required: true }) ?? "",
      role: row.role,
      target_enzyme: target,
      also_targets: alsoTargets,
      concentration_unit: "uM",
      reagent_lot_id: read.id(row.reagent_lot_id),
      stage: stageFor(`${path}.stage`, row.stage),
      ...solvent,
      incubation_minutes: minutesIn(`${path}.incubation_minutes`, row.incubation_minutes),
    };
    const reference = chosenControl(`${path}.reference_control`, row.reference_control, row.stage, (control) =>
      isReferenceType(control.control_type),
    );
    const present = concentrations.map((concentration) => ({
      ...base,
      concentration,
      cofactor_omitted: false,
      omitted_cofactor: null,
      reference_control: reference,
      replicates: replicatesOf(`${path}.replicates`, row.replicates),
    }));
    if (!row.without_cofactor) return present;
    const omitted = omittedCofactor(`${path}.omitted_cofactor`, row.omitted_cofactor);
    const twinReference = chosenControl(
      `${path}.twin_reference_control`,
      row.twin_reference_control,
      row.stage,
      (control) => control.control_type === "minus_cofactor" && control.omitted_cofactor === row.omitted_cofactor,
    );
    return [
      ...present,
      ...concentrations.map((concentration) => ({
        ...base,
        concentration,
        cofactor_omitted: true,
        omitted_cofactor: omitted,
        reference_control: twinReference,
        replicates: replicatesOf(`${path}.twin_replicates`, row.twin_replicates),
      })),
    ];
  });

  const internalStandard = internalStandardBody(draft, read);

  const seenEnzymes: string[] = [];
  const pathways = draft.pathways.map((row, index) => {
    const enzyme = read.text(`pathways.${index}.enzyme`, row.enzyme, { required: true }) ?? "";
    if (enzyme && seenEnzymes.some((seen) => sameName(seen, enzyme))) {
      read.fail(`pathways.${index}.enzyme`, `${enzyme} is already listed.`);
    }
    seenEnzymes.push(enzyme);
    return { enzyme, pathway_role: row.pathway_role, organ_context: "hepatic" as const };
  });

  return read.result({
    code: read.text("code", draft.code),
    title: read.text("title", draft.title, { required: true }) ?? "",
    study_type: draft.study_type || "substrate_depletion",
    experiment_date: draft.experiment_date || null,
    performed_by: read.id(draft.performed_by),
    protocol_id: read.id(draft.protocol_id),
    substrate: read.text("substrate", draft.substrate, { required: true }) ?? "",
    substrate_reagent_lot_id: read.id(draft.substrate_reagent_lot_id),
    tissue_lot_id: read.id(draft.tissue_lot_id),
    objective: read.text("objective", draft.objective),
    sampling: draft.sampling,
    condition: {
      incubation_temperature: read.number("condition.incubation_temperature", c.incubation_temperature),
      preincubation_time: preincubation,
      buffer: read.text("condition.buffer", c.buffer),
      ph: read.number("condition.ph", c.ph),
      solvent: read.text("condition.solvent", c.solvent),
      solvent_percentage: read.number("condition.solvent_percentage", c.solvent_percentage),
      fu_inc: read.number("condition.fu_inc", c.fu_inc),
    },
    cofactors: draft.cofactors.map((row, index) => {
      const path = `cofactors.${index}`;
      const concentration = read.number(`${path}.concentration`, row.concentration);
      if (row.role === "") read.fail(`${path}.role`, "Choose what it is for.");
      const solution = row.new_solution;
      return {
        cofactor: read.text(`${path}.cofactor`, row.cofactor, { required: true }) ?? "",
        role: row.role || null,
        concentration,
        concentration_unit: concentration === null ? null : row.concentration_unit,
        reagent_lot_id: read.id(row.reagent_lot_id),
        prepared_solution_id: row.solution && row.solution !== NEW_SOLUTION ? Number(row.solution) : null,
        solution:
          row.solution === NEW_SOLUTION
            ? {
                label: read.text(`${path}.solution.label`, solution.label, { required: true }) ?? "",
                prepared_by: read.id(solution.prepared_by),
                prepared_on: solution.prepared_on || null,
                buffer_composition: read.text(`${path}.solution.buffer_composition`, solution.buffer_composition),
              }
            : null,
      };
    }),
    controls,
    arms,
    pathways,
    stages,
    internal_standard: internalStandard,
  });
}

/** The internal standard as the API takes it, or null when no compound is named. It can be neither the
 * substrate nor an arm's inhibitor. */
function internalStandardBody(draft: ExperimentDraft, read: ReturnType<typeof draftReader>): Schemas["InternalStandardIn"] | null {
  const row = draft.internal_standard;
  const compound = read.text("internal_standard.compound", row.compound);
  if (!compound) {
    if (row.concentration.trim() || row.reagent_lot_id) {
      read.fail("internal_standard.compound", "Name the internal standard, or clear its concentration and lot.");
    }
    return null;
  }
  if (sameName(compound, draft.substrate)) read.fail("internal_standard.compound", "The internal standard can't be the substrate.");
  if (draft.arms.some((arm) => sameName(arm.inhibitor, compound))) {
    read.fail("internal_standard.compound", `${compound} is an arm's inhibitor, so it can't also be the internal standard.`);
  }
  const concentration = read.number("internal_standard.concentration", row.concentration);
  if (concentration !== null && concentration <= 0) read.fail("internal_standard.concentration", "Must be more than 0.");
  return {
    compound,
    concentration,
    concentration_unit: concentration === null ? null : row.concentration_unit,
    addition_step: row.addition_step,
    solvent: read.text("internal_standard.solvent", row.solvent),
    reagent_lot_id: read.id(row.reagent_lot_id),
  };
}

/** An arm's solvent and percentage as the API takes them. A vehicle's solvent is copied with its
 * percentage, so the arm matches that vehicle when its reference is resolved. */
function armSolvent(
  draft: ExperimentDraft,
  row: ArmDraft,
  path: string,
  read: ReturnType<typeof draftReader>,
): { solvent: string | null; solvent_percentage: number | null } {
  if (row.solvent === "") return { solvent: null, solvent_percentage: null };
  if (row.solvent === NO_SOLVENT) return { solvent: NO_SOLVENT, solvent_percentage: null };
  if (row.solvent === TYPED_SOLVENT) {
    const solvent = read.text(`${path}.typed_solvent`, row.typed_solvent, { required: true });
    if (solvent?.toLowerCase() === NO_SOLVENT) return { solvent: NO_SOLVENT, solvent_percentage: null };
    const percentage = read.number(`${path}.solvent_percentage`, row.solvent_percentage);
    if (percentage !== null && (percentage < 0 || percentage > 100)) read.fail(`${path}.solvent_percentage`, "Between 0 and 100.");
    return { solvent, solvent_percentage: percentage };
  }
  const vehicle = draft.controls.find((control) => vehicleSolvent(control.key) === row.solvent);
  if (!vehicle || vehicle.stage !== row.stage || vehicle.control_type !== "vehicle" || !vehicle.solvent.trim()) {
    read.fail(`${path}.solvent`, "Choose the solvent again: the vehicle it came from has changed.");
    return { solvent: null, solvent_percentage: null };
  }
  return { solvent: vehicle.solvent.trim(), solvent_percentage: typedNumber(vehicle.solvent_percentage) };
}

const text = (value: string | number | null | undefined): string => (value === null || value === undefined ? "" : String(value));

/** The form's draft for a saved design, the reverse of `experimentBody`. Null when the design uses something the
 * form has no field for, such as a unit outside its lists or a run without cofactor that has no run with it. */
export function draftFromBody(body: Schemas["ExperimentIn"]): ExperimentDraft | null {
  const stages = (body.stages ?? []).map((stage) => ({
    key: rowKey(),
    incubation_minutes: text(stage.incubation_minutes),
    protein_concentration: text(stage.protein_concentration),
    cell_density: text(stage.cell_density),
    dilution_factor: text(stage.dilution_factor),
  }));
  const stageKey = new Map((body.stages ?? []).map((stage, index) => [stage.stage_type, stages[index]?.key ?? 0]));
  const keyOfStage = (type: StageType | undefined) => stageKey.get(type ?? "primary") ?? stages[0]?.key ?? 0;

  const componentUnits: readonly string[] = COMPONENT_UNITS;
  if ((body.cofactors ?? []).some((row) => row.concentration_unit && !componentUnits.includes(row.concentration_unit))) return null;
  const cofactors: CofactorDraft[] = (body.cofactors ?? []).map((row) => ({
    ...blankCofactor(),
    cofactor: row.cofactor,
    role: row.role ?? "",
    concentration: text(row.concentration),
    concentration_unit: (row.concentration_unit as CofactorDraft["concentration_unit"] | null) ?? "mM",
    reagent_lot_id: text(row.reagent_lot_id),
    solution: text(row.prepared_solution_id),
  }));
  const cofactorKey = (index: number | null | undefined) =>
    index === null || index === undefined ? EVERY_COFACTOR : text(cofactors[index]?.key);

  const controls: ControlDraft[] = (body.controls ?? []).map((row) => ({
    key: rowKey(),
    stage: keyOfStage(row.stage),
    control_type: row.control_type,
    label: text(row.label),
    solvent: text(row.solvent),
    solvent_percentage: text(row.solvent_percentage),
    omitted_cofactor: cofactorKey(row.omitted_cofactor),
    protein_concentration: text(row.protein_concentration),
    incubation_minutes: text(row.incubation_minutes),
    replicates: text(row.replicates),
  }));
  const controlKey = (index: number | null | undefined) => (index === null || index === undefined ? "" : text(controls[index]?.key));

  const arms: ArmDraft[] = [];
  const armAt = new Map<string, ArmDraft>();
  for (const row of body.arms ?? []) {
    const identity = `${row.stage ?? "primary"}|${row.inhibitor.trim().toLowerCase()}`;
    let arm = armAt.get(identity);
    if (arm === undefined) {
      if (row.cofactor_omitted) return null;
      const stage = keyOfStage(row.stage);
      const vehicles = controls.filter(
        (control) =>
          control.stage === stage &&
          control.control_type === "vehicle" &&
          control.solvent.trim() === (row.solvent ?? "") &&
          typedNumber(control.solvent_percentage) === (row.solvent_percentage ?? null),
      );
      const solvent =
        row.solvent === null || row.solvent === undefined
          ? ""
          : row.solvent === NO_SOLVENT
            ? NO_SOLVENT
            : vehicles.length === 1 && vehicles[0]
              ? vehicleSolvent(vehicles[0].key)
              : TYPED_SOLVENT;
      arm = {
        ...blankArm(body.study_type ?? "", stage),
        inhibitor: row.inhibitor,
        role: row.role ?? "inhibitor",
        target_enzyme: text(row.target_enzyme),
        also_targets: (row.also_targets ?? []).map((enzyme) => ({ key: rowKey(), enzyme })),
        reagent_lot_id: text(row.reagent_lot_id),
        solvent,
        typed_solvent: solvent === TYPED_SOLVENT ? text(row.solvent) : "",
        solvent_percentage: solvent === TYPED_SOLVENT ? text(row.solvent_percentage) : "",
        concentrations: [],
        reference_control: controlKey(row.reference_control),
        incubation_minutes: text(row.incubation_minutes),
        replicates: text(row.replicates),
      };
      armAt.set(identity, arm);
      arms.push(arm);
    }
    if (row.cofactor_omitted) {
      arm.without_cofactor = true;
      arm.omitted_cofactor = cofactorKey(row.omitted_cofactor);
      arm.twin_reference_control = controlKey(row.reference_control);
      arm.twin_replicates = text(row.replicates);
    } else {
      arm.concentrations.push({ key: rowKey(), concentration: text(row.concentration) });
    }
  }

  const standard = body.internal_standard;
  const standardUnits: readonly string[] = INTERNAL_STANDARD_UNITS;
  if (standard?.concentration_unit && !standardUnits.includes(standard.concentration_unit)) return null;
  const condition = body.condition ?? {};
  return {
    title: body.title,
    study_type: body.study_type ?? "",
    experiment_date: text(body.experiment_date),
    performed_by: text(body.performed_by),
    protocol_id: text(body.protocol_id),
    code: text(body.code),
    objective: text(body.objective),
    substrate: body.substrate,
    substrate_reagent_lot_id: text(body.substrate_reagent_lot_id),
    tissue_lot_id: text(body.tissue_lot_id),
    sampling: body.sampling,
    condition: {
      incubation_temperature: text(condition.incubation_temperature),
      preincubation_time: text(condition.preincubation_time),
      buffer: text(condition.buffer),
      ph: text(condition.ph),
      solvent: text(condition.solvent),
      solvent_percentage: text(condition.solvent_percentage),
      fu_inc: text(condition.fu_inc),
    },
    stages,
    controls,
    cofactors,
    arms,
    pathways: (body.pathways ?? []).map((row) => ({ key: rowKey(), enzyme: row.enzyme, pathway_role: row.pathway_role })),
    internal_standard: standard
      ? {
          compound: standard.compound,
          concentration: text(standard.concentration),
          concentration_unit: (standard.concentration_unit as InternalStandardDraft["concentration_unit"] | null) ?? "nM",
          addition_step: standard.addition_step ?? "reaction_termination",
          solvent: text(standard.solvent),
          reagent_lot_id: text(standard.reagent_lot_id),
        }
      : blankExperiment({ memberId: null }).internal_standard,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** Two requests that write the same experiment, an absent field counting as null. */
export function sameRequest(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
