import {
  CalendarClock,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  PackageX,
  ShieldAlert,
  ShieldCheck,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Schemas } from "@/api/client";
import { count, humanize, plain, unit } from "./format";

export type Tone = "good" | "warning" | "serious" | "critical" | "progress" | "neutral";

export const TONE_CLASS: Record<Tone, string> = {
  good: "bg-good-bg text-good-fg border-good-line",
  warning: "bg-warning-bg text-warning-fg border-warning-line",
  serious: "bg-serious-bg text-serious-fg border-serious-line",
  critical: "bg-critical-bg text-critical-fg border-critical-line",
  progress: "bg-progress-bg text-progress-fg border-progress-line",
  neutral: "bg-neutral-bg text-neutral-fg border-neutral-line",
};

type StatusMeta = { label: string; tone: Tone; icon: LucideIcon };

const EXPERIMENT_STATUS: Record<string, StatusMeta> = {
  planned: { label: "Planned", tone: "neutral", icon: CalendarClock },
  in_progress: { label: "In progress", tone: "progress", icon: Timer },
  completed: { label: "Completed", tone: "good", icon: CircleCheck },
  qc_passed: { label: "QC passed", tone: "good", icon: ShieldCheck },
  qc_failed: { label: "QC failed", tone: "critical", icon: ShieldAlert },
  failed: { label: "Failed", tone: "critical", icon: CircleX },
};

/** The API types status as a plain string, so unknown values still render, just without a tone. */
export function experimentStatus(status: string): StatusMeta {
  return EXPERIMENT_STATUS[status] ?? { label: humanize(status), tone: "neutral", icon: Circle };
}

export type ExperimentStatus = Schemas["StatusChange"]["status"];

/** Every status an experiment can be moved to, in the order work usually goes. */
export const EXPERIMENT_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "qc_passed",
  "qc_failed",
  "failed",
] as const satisfies readonly ExperimentStatus[];

export type ArmKind = Schemas["ArmInfo"]["kind"];

export const ARM_KIND_LABEL: Record<ArmKind, string> = {
  control: "Control",
  negative_control: "Negative control",
  inhibitor: "Inhibitor",
  selectivity_control: "Selectivity control",
};

export type LotFlag = Schemas["LotAlert"]["flags"][number];

type FlagSubject = { days_to_expiry: number | null; percent_remaining?: number | null };

export const LOT_FLAG: Record<LotFlag, { tone: Tone; icon: LucideIcon; label: (lot: FlagSubject) => string }> = {
  expired: {
    tone: "critical",
    icon: CircleX,
    label: (lot) =>
      lot.days_to_expiry !== null && lot.days_to_expiry < 0 ? `Expired ${count(-lot.days_to_expiry, "day")} ago` : "Expired",
  },
  expiring_soon: {
    tone: "warning",
    icon: Clock,
    label: (lot) => {
      if (lot.days_to_expiry === null) return "Expiring soon";
      return lot.days_to_expiry === 0 ? "Expires today" : `Expires in ${count(lot.days_to_expiry, "day")}`;
    },
  },
  low_stock: {
    tone: "serious",
    icon: TriangleAlert,
    label: (lot) =>
      lot.percent_remaining === null || lot.percent_remaining === undefined
        ? "Low stock"
        : `Low stock, ${plain(lot.percent_remaining)}% left`,
  },
  depleted: { tone: "critical", icon: PackageX, label: () => "Depleted" },
};

export type ExclusionReason = Schemas["Exclusion"]["reason"];

export const EXCLUSION_REASONS = [
  "pipetting error",
  "carryover",
  "missing peak",
  "integration failure",
  "sample lost",
  "other",
] as const satisfies readonly ExclusionReason[];

type Assert<T extends true> = T;
export type ReasonsAreExhaustive = Assert<
  Exclude<ExclusionReason, (typeof EXCLUSION_REASONS)[number]> extends never ? true : false
>;

export type StudyType = Schemas["ExperimentIn"]["study_type"];
export type ArmRole = Schemas["ArmIn"]["role"];
export type PathwayRole = Schemas["PathwayIn"]["pathway_role"];
export type ReagentType = NonNullable<Schemas["ReagentLotIn"]["reagent_type"]>;

export const ARM_ROLES = ["inhibitor", "inducer", "probe_substrate", "antibody_inhibitor"] as const satisfies readonly ArmRole[];

export type ArmRolesAreExhaustive = Assert<Exclude<ArmRole, (typeof ARM_ROLES)[number]> extends never ? true : false>;
export type StatusesAreExhaustive = Assert<Exclude<ExperimentStatus, (typeof EXPERIMENT_STATUSES)[number]> extends never ? true : false>;

export type ControlType = Schemas["ControlIn"]["control_type"];

/** Control types in the order the form offers them, each with its name in the type list. */
export const CONTROL_TYPE_LABEL = {
  vehicle: "Vehicle",
  complete: "Complete incubation, no solvent",
  minus_cofactor: "Minus cofactor",
  minus_substrate: "Minus substrate",
  minus_protein: "Minus protein or cells",
  heat_inactivated: "Heat-inactivated",
  other: "Other",
} as const satisfies Record<ControlType, string>;

export const CONTROL_TYPES = Object.keys(CONTROL_TYPE_LABEL) as ControlType[];

/** The controls an inhibitor arm can be compared against; the rest are negative controls. */
export const REFERENCE_CONTROL_TYPES = ["vehicle", "complete"] as const satisfies readonly ControlType[];

export function isReferenceType(type: ControlType): boolean {
  return (REFERENCE_CONTROL_TYPES as readonly ControlType[]).includes(type);
}

/** Units offered where a value is typed, in the API's ASCII spelling ("uM"); `format.unit` shows "µM". */
export const LOT_CONCENTRATION_UNITS = ["mM", "uM", "nM", "M", "mg/mL", "ug/mL"] as const;
export const AMOUNT_UNITS = ["mL", "uL", "mg", "g", "ug"] as const;
export const SUBSTRATE_CONCENTRATION_UNITS = ["uM", "nM", "mM"] as const;
export const INTERNAL_STANDARD_UNITS = ["nM", "uM", "ng/mL"] as const;
/** Units for what a regenerating system holds and for an incubation's components. */
export const COMPONENT_UNITS = ["mM", "uM", "U/mL", "mg/mL", "uL/mL", "%"] as const;

export type ComponentRole = NonNullable<Schemas["CofactorIn"]["role"]>;

/** What each component of an incubation is for, in the order the form offers. */
export const COMPONENT_ROLE_LABEL = {
  cofactor: "Cofactor",
  solvent: "Solvent",
  substrate: "Substrate",
  other: "Other",
} as const satisfies Record<ComponentRole, string>;

export const COMPONENT_ROLES = Object.keys(COMPONENT_ROLE_LABEL) as ComponentRole[];

/** The reagent types whose lots fit a component of each role; any lot fits an "other" one. */
export const LOT_TYPES_FOR_ROLE: Record<ComponentRole, readonly ReagentType[] | null> = {
  cofactor: ["cofactor", "regenerating_system"],
  solvent: ["solvent"],
  substrate: ["substrate"],
  other: null,
};

export type AdditionStep = Schemas["InternalStandardIn"]["addition_step"];

/** When the internal standard goes in, in the order the form offers. */
export const ADDITION_STEP_LABEL = {
  reaction_termination: "At reaction termination",
  sample_preparation: "During sample preparation",
  reconstitution: "At reconstitution",
  other: "At another step",
} as const satisfies Record<AdditionStep, string>;

export const ADDITION_STEPS = Object.keys(ADDITION_STEP_LABEL) as AdditionStep[];

export type Sampling = Schemas["ExperimentIn"]["sampling"];

export const SAMPLING_LABEL = {
  time_course: "Time course",
  endpoint: "Single endpoint",
} as const satisfies Record<Sampling, string>;

export const SAMPLINGS = Object.keys(SAMPLING_LABEL) as Sampling[];

/** A lot saved with a unit outside the list keeps it as a choice, so editing never changes it silently. */
export function unitChoices(units: readonly string[], current: string | null): { value: string; label: string }[] {
  const all = current && !units.includes(current) ? [current, ...units] : units;
  return all.map((value) => ({ value, label: unit(value) }));
}

export function reasonLabel(reason: ExclusionReason): string {
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Saved reasons arrive as free text; anything outside the list needs a new choice before saving. */
export function parseReason(raw: string | null): ExclusionReason | null {
  return EXCLUSION_REASONS.find((reason) => reason === raw) ?? null;
}

export type ArmStyle = { color: string; symbol: string; muted: boolean; dashed: boolean };

/** UNC navy for reference controls, then Carolina blue and Ohio State scarlet for the first two inhibitors.
 * Each clears 3:1 against the white plot; marker shapes keep arms apart without colour. */
export const CHART_INK = "#13294b";
export const CHART_MUTED = "#7d878f";
export const CHART_EXCLUDED = "#9aa3aa";
const CATEGORICAL = ["#3d8fcf", "#ba0c2f", "#1baf7a", "#eda100", "#6250d6", "#008300", "#e87ba4", "#d0632b"] as const;
const SYMBOLS = ["circle", "square", "diamond", "triangle-up", "triangle-down", "hexagon", "star", "pentagon"] as const;
/** Shapes no arm or reference control ever takes, so a grey negative control never looks like a grey selectivity control. */
const NEGATIVE_SYMBOLS = ["x", "cross", "hourglass", "bowtie", "hexagram", "star-diamond", "diamond-tall", "octagon"] as const;

type StyledArm = { key: string; kind: ArmKind; group_key?: string | null; cofactor_omitted?: boolean };

/** Colour follows the arm's group, in the experiment's arm order. Reference controls are ink, negative
 * and selectivity controls are muted, and each inhibitor group takes the next categorical slot, so every
 * concentration of one inhibitor shares a hue and its run without cofactor draws dashed in that hue.
 * Past eight groups an arm is muted rather than given a generated hue. Negative controls take shapes from a
 * set of their own, so adding one never reshapes the rest and none shares a shape with an arm. */
export function armStyles(arms: readonly StyledArm[]): ReadonlyMap<string, ArmStyle> {
  const slots = new Map<string, string | undefined>();
  let shape = 0;
  let negativeShape = 0;
  return new Map(
    arms.map((arm): [string, ArmStyle] => {
      const dashed = arm.cofactor_omitted ?? false;
      if (arm.kind === "negative_control") {
        const symbol = NEGATIVE_SYMBOLS[negativeShape++ % NEGATIVE_SYMBOLS.length] ?? "x";
        return [arm.key, { color: CHART_MUTED, symbol, muted: true, dashed }];
      }
      const symbol = SYMBOLS[shape++ % SYMBOLS.length] ?? "circle";
      if (arm.kind === "control") return [arm.key, { color: CHART_INK, symbol, muted: false, dashed }];
      if (arm.kind === "selectivity_control") return [arm.key, { color: CHART_MUTED, symbol, muted: true, dashed }];
      const group = arm.group_key ?? arm.key;
      if (!slots.has(group)) slots.set(group, CATEGORICAL[slots.size]);
      const color = slots.get(group);
      return [arm.key, color ? { color, symbol, muted: false, dashed } : { color: CHART_MUTED, symbol, muted: true, dashed }];
    }),
  );
}

/** A negative control's percent remaining, cut rather than rounded to one decimal, as the API's check lines
 * show it, so a value under the threshold never reads as the threshold. */
export function percentLeft(value: number): string {
  return plain(Math.floor(value * 10) / 10);
}

/** "0.1% DMSO", or the solvent alone when no percentage is recorded. */
export function solventText(solvent: string | null | undefined, percentage: number | null | undefined): string | null {
  if (!solvent) return null;
  return percentage !== null && percentage !== undefined ? `${plain(percentage)}% ${solvent}` : solvent;
}
