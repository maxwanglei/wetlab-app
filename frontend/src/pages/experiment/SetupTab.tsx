import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { Fragment, useState, type ReactNode } from "react";
import { errorMessage, type Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { ArmSwatch } from "@/components/ArmSwatch";
import { ComponentList } from "@/components/ComponentList";
import { ArmKindBadge, ToneBadge, ValidAtUseBadge } from "@/components/badges";
import { Select } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADDITION_STEP_LABEL, CONTROL_TYPE_LABEL, SAMPLING_LABEL, solventText, type ArmStyle } from "@/lib/domain";
import * as format from "@/lib/format";
import { g } from "@/pages/new-experiment/experiment-draft";

type Experiment = Schemas["ExperimentDetail"];

export function SetupTab({ experiment, styles }: { experiment: Experiment; styles: ReadonlyMap<string, ArmStyle> }) {
  return (
    <div className="space-y-6">
      <section aria-label="Objective" className="max-w-[72ch]">
        <h2 className="text-sm font-bold text-ink-3">Objective</h2>
        <p className="mt-1 text-[1.0625rem] leading-relaxed">{experiment.objective ?? "No objective recorded."}</p>
        {experiment.notes ? <p className="mt-2 text-ink-2">{experiment.notes}</p> : null}
      </section>

      <DesignSummary experiment={experiment} />

      <div className="grid gap-6 lg:grid-cols-3">
        <EnzymeSource experiment={experiment} />
        <Conditions condition={experiment.condition} stages={experiment.stages} />
        <SubstrateAndCofactors experiment={experiment} />
      </div>

      <Controls experiment={experiment} styles={styles} />
      <Arms experiment={experiment} styles={styles} />

      <div className="grid gap-6 lg:grid-cols-12">
        <Protocol protocol={experiment.protocol} />
        <Pathways enzymes={experiment.enzymes} />
      </div>
    </div>
  );
}

function SpecList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7.5rem,auto)_1fr] gap-x-4 gap-y-2 text-[0.9375rem]">
      {items.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="tabular-nums">{value ?? <span className="text-ink-3">Not recorded</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function LotLine({ lot }: { lot: Schemas["LotRef"] }) {
  return (
    <span className="flex flex-col gap-1">
      <span>
        <span className="font-bold tracking-wide">{lot.lot_number}</span>{" "}
        <span className="text-ink-2">{lot.name}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
        <ValidAtUseBadge valid={lot.valid_at_use} />
        {lot.expiry_date ? <span>Expires {format.date(lot.expiry_date)}</span> : null}
      </span>
    </span>
  );
}

function EnzymeSource({ experiment }: { experiment: Experiment }) {
  const tissue = experiment.tissue;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Enzyme source</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tissue ? (
          <>
            <SpecList
              items={[
                ["Lot", <span className="font-bold tracking-wide">{tissue.lot_number ?? "No lot number"}</span>],
                ["Validity", <ValidAtUseBadge valid={tissue.valid_at_use} />],
                ["Material", tissue.material_type ? format.humanize(tissue.material_type) : null],
                [
                  "Donors",
                  tissue.pooled_or_individual
                    ? `${format.humanize(tissue.pooled_or_individual)}${
                        tissue.number_of_donors !== null ? `, ${format.count(tissue.number_of_donors, "donor")}` : ""
                      }`
                    : null,
                ],
                ["Source", tissue.vendor_or_source],
                ["Expiry", format.date(tissue.expiry_date)],
              ]}
            />
            <Link
              to={`/inventory/tissue-lots/${tissue.id}`}
              className="mt-1 self-start text-sm font-bold text-ballpoint underline-offset-2 hover:underline"
            >
              Donors and lot details
            </Link>
          </>
        ) : (
          <p className="text-ink-3">No tissue lot linked.</p>
        )}
      </CardContent>
    </Card>
  );
}

function powerOfTenUnit(rawUnit: string | null): { exponent: string; rest: string } | null {
  const match = rawUnit ? /^10\^(\d+)\s+(.*)$/.exec(rawUnit) : null;
  return match?.[1] && match[2] ? { exponent: match[1], rest: match[2] } : null;
}

function CellDensity({ value, rawUnit }: { value: number; rawUnit: string | null }) {
  const unit = powerOfTenUnit(rawUnit);
  if (!unit) return <>{format.quantity(value, rawUnit)}</>;
  return (
    <>
      {format.plain(value)} × 10<sup>{unit.exponent}</sup> {unit.rest}
    </>
  );
}

const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function cellDensityText(value: number, rawUnit: string | null): string {
  const unit = powerOfTenUnit(rawUnit);
  if (!unit) return format.quantity(value, rawUnit) ?? format.plain(value);
  const exponent = [...unit.exponent].map((digit) => SUPERSCRIPT_DIGITS[Number(digit)]).join("");
  return `${format.plain(value)} ×10${exponent} ${unit.rest}`;
}

function stageSummary(stage: Schemas["StageOut"]): string {
  const parts = [format.quantity(stage.incubation_minutes, "min")];
  if (stage.cell_density !== null) parts.push(cellDensityText(stage.cell_density, stage.cell_density_unit));
  else parts.push(format.quantity(stage.protein_concentration, stage.protein_concentration_unit));
  if (stage.dilution_factor !== null && stage.diluted_from !== null) {
    parts.push(`a ${format.plain(stage.dilution_factor)}-fold dilution of the ${stage.diluted_from} stage`);
  }
  return parts.filter(Boolean).join(", ");
}

/** The design at a glance, stage by stage: how many inhibitors and conditions, and how many reference and
 * negative controls, counted apart so a vehicle never counts as a negative. The internal standard is named on
 * its own and counts as neither. Setup values that disagree are listed under it. */
function DesignSummary({ experiment }: { experiment: Experiment }) {
  const standard = experiment.internal_standard;
  const last = experiment.stages.at(-1);
  return (
    <section aria-labelledby="summary-heading" data-testid="design-summary" className="rounded-lg border border-rule bg-surface">
      <div className="px-5 pt-4 pb-2">
        <h2 id="summary-heading" className="text-base font-bold">
          Design summary
        </h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Stage</TableHead>
            <TableHead>Incubation</TableHead>
            <TableHead>Arms</TableHead>
            <TableHead className="text-right">Reference controls</TableHead>
            <TableHead className="pr-5 text-right">Negative controls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {experiment.stages.map((stage) => {
            const inStage = experiment.arms.filter((arm) => arm.stage === stage.stage_type);
            const armRows = inStage.filter((arm) => arm.modulator_id !== null);
            const inhibitors = new Set(armRows.map((arm) => arm.group_key ?? arm.key)).size;
            return (
              <TableRow key={stage.stage_type}>
                <TableCell className="pl-5 font-bold">{format.humanize(stage.stage_type)}</TableCell>
                <TableCell>{stageSummary(stage)}</TableCell>
                <TableCell>
                  {format.count(inhibitors, "inhibitor")}
                  {armRows.length !== inhibitors ? <span className="text-ink-3">, {format.count(armRows.length, "condition")}</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{inStage.filter((arm) => arm.kind === "control").length}</TableCell>
                <TableCell className="pr-5 text-right tabular-nums">
                  {inStage.filter((arm) => arm.kind === "negative_control").length}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="space-y-2 border-t border-rule px-5 py-3 text-[0.9375rem]">
        <p>
          <span className="text-ink-3">Sampling:</span> {SAMPLING_LABEL[experiment.sampling]}
          {experiment.sampling === "endpoint" && last ? (
            <>
              , each condition read once at the end of the {last.stage_type} stage
              {last.incubation_minutes !== null ? ` (${format.quantity(last.incubation_minutes, "min")})` : ""}
            </>
          ) : null}
        </p>
        <p>
          <span className="text-ink-3">Internal standard:</span>{" "}
          {standard ? (
            <>
              <span className="font-bold">{standard.compound}</span>{" "}
              <span className="tabular-nums">{format.quantity(standard.concentration, standard.concentration_unit)}</span>
            </>
          ) : (
            "none"
          )}
        </p>
        {experiment.warnings.length > 0 ? (
          <ul className="space-y-1">
            {experiment.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`} className="flex gap-2 text-sm font-bold text-warning-fg">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function Conditions({ condition, stages }: { condition: Schemas["ConditionOut"] | null; stages: readonly Schemas["StageOut"][] }) {
  if (!condition) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Incubation conditions</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ink-3">No incubation conditions recorded.</p>
        </CardContent>
      </Card>
    );
  }
  const items: [ReactNode, ReactNode][] = [];
  const staged = stages.length > 1;
  if (staged) {
    for (const stage of stages) items.push([`${format.humanize(stage.stage_type)} stage`, stageSummary(stage)]);
  } else {
    if (condition.protein_concentration !== null || condition.cell_density === null) {
      items.push(["Protein", format.quantity(condition.protein_concentration, condition.protein_concentration_unit)]);
    }
    if (condition.cell_density !== null) {
      items.push(["Cell density", <CellDensity value={condition.cell_density} rawUnit={condition.cell_density_unit} />]);
    }
  }
  items.push(["Temperature", format.quantity(condition.incubation_temperature, condition.incubation_temperature_unit)]);
  if (!staged) items.push(["Incubation", format.quantity(condition.incubation_time, condition.incubation_time_unit)]);
  items.push(
    ["Preincubation", format.quantity(condition.preincubation_time, condition.preincubation_time_unit)],
    ["Buffer", condition.buffer],
    ["pH", condition.ph !== null ? format.plain(condition.ph) : null],
    [
      "Solvent",
      condition.solvent
        ? condition.solvent_percentage !== null
          ? `${format.plain(condition.solvent_percentage)}% ${condition.solvent}`
          : condition.solvent
        : null,
    ],
    ["Linearity confirmed", condition.linearity_confirmed ? format.humanize(condition.linearity_confirmed) : null],
    [
      <>
        f<sub>u,inc</sub>
      </>,
      condition.fu_inc !== null ? (
        <>
          {format.fixed(condition.fu_inc, 2)} <span className="text-ink-3">(fraction unbound in the incubation)</span>
        </>
      ) : null,
    ],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Incubation conditions</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <SpecList items={items} />
      </CardContent>
    </Card>
  );
}

type Component = Experiment["cofactors"][number];

const ROLE_GROUPS: { role: Component["role"]; title: string }[] = [
  { role: "cofactor", title: "Cofactors" },
  { role: "solvent", title: "Solvents" },
  { role: "substrate", title: "Substrate components" },
  { role: "other", title: "Other components" },
  { role: null, title: "Unclassified" },
];

/** The incubation's components grouped by role. An unclassified one, from before roles existed, says so rather
 * than passing for a cofactor. */
function Components({ components, experimentId }: { components: readonly Component[]; experimentId: number }) {
  if (components.length === 0) {
    return (
      <div>
        <h3 className="text-sm text-ink-3">Components</h3>
        <p className="mt-0.5 text-ink-3">None recorded</p>
      </div>
    );
  }
  return (
    <>
      {ROLE_GROUPS.map(({ role, title }) => {
        const inRole = components.filter((component) => component.role === role);
        if (inRole.length === 0) return null;
        return (
          <div key={title} data-testid={`components-${role ?? "unclassified"}`}>
            <h3 className="text-sm text-ink-3">{title}</h3>
            <ul className="mt-0.5 space-y-3">
              {inRole.map((component, index) => (
                <li key={`${index}-${component.cofactor}`}>
                  <p>
                    <span className="font-bold">{component.cofactor}</span>{" "}
                    <span className="tabular-nums">{format.quantity(component.concentration, component.concentration_unit)}</span>
                  </p>
                  <div className="mt-1">
                    {component.lot ? <LotLine lot={component.lot} /> : <span className="text-sm text-ink-3">No lot linked</span>}
                  </div>
                  {component.components.length > 0 ? (
                    <div className="mt-1 border-l-2 border-rule-strong pl-3">
                      <ComponentList components={component.components} />
                    </div>
                  ) : null}
                  {component.solution ? <SolutionLine solution={component.solution} experimentId={experimentId} /> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function SolutionLine({ solution, experimentId }: { solution: Schemas["PreparedSolutionOut"]; experimentId: number }) {
  const made = [solution.prepared_by ? `by ${solution.prepared_by}` : null, solution.prepared_on ? `on ${format.date(solution.prepared_on)}` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <p className="mt-1 text-sm text-ink-2">
      From <span className="font-bold">{solution.label}</span>
      {made ? `, prepared ${made}` : null}
      {solution.prepared_by ? null : <span className="text-warning-fg">, preparer not recorded</span>}
      {solution.buffer_composition ? <span className="block text-ink-3">{solution.buffer_composition}</span> : null}
      {solution.prepared_by ? null : <RecordPreparer solution={solution} experimentId={experimentId} />}
    </p>
  );
}

/** Records who prepared a solution when that was not known at creation, so a finished run can name them. */
function RecordPreparer({ solution, experimentId }: { solution: Schemas["PreparedSolutionOut"]; experimentId: number }) {
  const queryClient = useQueryClient();
  const members = useQuery(queries.reference()).data?.members ?? [];
  const [member, setMember] = useState("");
  const record = useMutation({
    mutationFn: () => mutations.updatePreparedSolution(solution.id, { prepared_by: Number(member) }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queries.experiment(experimentId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["reference"] }),
      ]);
    },
  });
  const id = `preparer-${solution.id}`;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-ink-2">
        Prepared by
      </label>
      <Select id={id} value={member} onChange={(event) => setMember(event.target.value)} className="w-auto">
        <option value="" disabled>
          Choose a lab member
        </option>
        {members.map((candidate) => (
          <option key={candidate.id} value={String(candidate.id)}>
            {candidate.name}
          </option>
        ))}
      </Select>
      <Button type="button" variant="outline" size="sm" disabled={!member || record.isPending} onClick={() => record.mutate()}>
        {record.isPending ? "Recording…" : "Record preparer"}
      </Button>
      {record.isError ? <span className="font-bold text-critical-fg">{errorMessage(record.error)}</span> : null}
    </span>
  );
}

/** The compound added to every sample to normalise the LC-MS signal. It is never an arm or a control. */
function InternalStandard({ standard }: { standard: Experiment["internal_standard"] }) {
  return (
    <div data-testid="internal-standard">
      <h3 className="text-sm text-ink-3">Internal standard</h3>
      {standard ? (
        <>
          <p className="mt-0.5">
            <span className="font-bold">{standard.compound}</span>{" "}
            <span className="tabular-nums">{format.quantity(standard.concentration, standard.concentration_unit)}</span>
          </p>
          <p className="text-sm text-ink-2">
            {ADDITION_STEP_LABEL[standard.addition_step]}
            {standard.solvent ? `, in ${standard.solvent}` : ""}
          </p>
          <div className="mt-1">
            {standard.lot ? <LotLine lot={standard.lot} /> : <span className="text-sm text-ink-3">No lot linked</span>}
          </div>
        </>
      ) : (
        <p className="mt-0.5 text-ink-3">None recorded</p>
      )}
    </div>
  );
}

function SubstrateAndCofactors({ experiment }: { experiment: Experiment }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Substrate, components and internal standard</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="gap-5">
        <div>
          <h3 className="text-sm text-ink-3">Substrate</h3>
          <p className="mt-0.5 font-bold">{experiment.substrate ?? "Not recorded"}</p>
          {experiment.substrate_concentrations.length > 0 && (
            <p className="text-sm text-ink-2">
              {format.quantities(experiment.substrate_concentrations)} in the incubation
            </p>
          )}
          <div className="mt-1">
            {experiment.substrate_lot ? (
              <LotLine lot={experiment.substrate_lot} />
            ) : (
              <span className="text-sm text-ink-3">No substrate lot linked</span>
            )}
          </div>
        </div>
        <Components components={experiment.cofactors} experimentId={experiment.id} />
        <InternalStandard standard={experiment.internal_standard} />
      </CardContent>
    </Card>
  );
}

type ArmInfo = Experiment["arms"][number];

const NONE = <span className="text-ink-3">–</span>;

/** Rows grouped by stage, with a heading row before each stage when the experiment has more than one. */
function byStage<T extends { stage?: string | null }>(rows: readonly T[], stages: number): { stage: string | null; rows: T[] }[] {
  if (stages <= 1) return [{ stage: null, rows: [...rows] }];
  const groups: { stage: string | null; rows: T[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.stage === (row.stage ?? null)) last.rows.push(row);
    else groups.push({ stage: row.stage ?? null, rows: [row] });
  }
  return groups;
}

function StageRow({ stage, columns }: { stage: string | null; columns: number }) {
  if (stage === null) return null;
  return (
    <TableRow className="bg-paper/60 hover:bg-paper/60">
      <TableCell colSpan={columns} className="pl-5 text-xs font-bold tracking-wide text-ink-3 uppercase">
        {format.humanize(stage)} stage
      </TableCell>
    </TableRow>
  );
}

function Label({ arm, style }: { arm: ArmInfo; style: ArmStyle | undefined }) {
  return (
    <span className="flex items-center gap-2">
      {style ? <ArmSwatch style={style} /> : null}
      <span className="font-bold">{arm.label}</span>
    </span>
  );
}

function Reference({ arm }: { arm: ArmInfo }) {
  if (arm.reference_label) {
    return (
      <>
        {arm.reference_label}
        {arm.reference_source === "fallback" ? <span className="block text-sm text-ink-3">the stage's only reference</span> : null}
        {arm.reference_source === "explicit" ? <span className="block text-sm text-ink-3">chosen on the arm</span> : null}
      </>
    );
  }
  return arm.reference_problem ? <span className="text-warning-fg">None chosen</span> : NONE;
}

/** How long a condition runs in its stage, shown for a single endpoint or when it is not its stage's time, and the
 * wells a single endpoint reads of it. */
function readout(arm: ArmInfo, experiment: Experiment): string[] {
  const endpoint = experiment.sampling === "endpoint";
  const stageMinutes = experiment.stages.find((stage) => stage.stage_type === arm.stage)?.incubation_minutes ?? null;
  const time = format.quantity(arm.incubation_minutes, "min");
  return [
    time !== null && (endpoint || arm.incubation_minutes !== stageMinutes) ? `${time} in its stage` : null,
    endpoint ? format.count(arm.replicates, "replicate") : null,
  ].filter((part) => part !== null);
}

/** An arm's concentration in the stage it enters, then what each later dilution leaves of it: "64 µM (6.4 µM in
 * secondary)". */
function Concentration({ arm, stages }: { arm: ArmInfo; stages: readonly Schemas["StageOut"][] }) {
  if (arm.concentration === null) return NONE;
  const carried: string[] = [];
  let value = arm.concentration;
  let next = stages.find((stage) => stage.diluted_from === arm.stage);
  while (next?.dilution_factor) {
    value /= next.dilution_factor;
    carried.push(`${[g(value), format.unit(arm.concentration_unit)].filter(Boolean).join(" ")} in ${next.stage_type}`);
    const from = next.stage_type;
    next = stages.find((stage) => stage.diluted_from === from);
  }
  return (
    <>
      {format.quantity(arm.concentration, arm.concentration_unit)}
      {carried.length > 0 ? (
        <>
          {" "}
          <span className="block text-sm text-ink-3">({carried.join(", ")})</span>
        </>
      ) : null}
    </>
  );
}

/** Every control, stage by stage: references first, then negative controls, as the API orders them. */
function Controls({ experiment, styles }: { experiment: Experiment; styles: ReadonlyMap<string, ArmStyle> }) {
  const controls = experiment.arms.filter((arm) => arm.control_id !== null);
  return (
    <section aria-labelledby="controls-heading" className="rounded-lg border border-rule bg-surface">
      <div className="px-5 pt-4 pb-2">
        <h2 id="controls-heading" className="text-base font-bold">
          Controls
        </h2>
        <p className="text-sm text-ink-3">
          Inhibitor arms are compared against a vehicle or complete incubation. Negative controls show what happens without a
          cofactor, substrate or active enzyme.
        </p>
      </div>
      {controls.length === 0 ? (
        <p className="px-5 pb-4 text-ink-3">No controls recorded.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Control</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Solvent</TableHead>
              <TableHead>Leaves out</TableHead>
              <TableHead className="pr-5">Compared against</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byStage(controls, experiment.stages.length).map((group) => (
              <Fragment key={group.stage ?? "only"}>
                <StageRow stage={group.stage} columns={6} />
                {group.rows.map((arm) => (
                  <TableRow key={arm.key}>
                    <TableCell className="pl-5">
                      <Label arm={arm} style={styles.get(arm.key)} />
                      {readout(arm, experiment).length > 0 ? (
                        <span className="mt-1 flex flex-wrap gap-2 pl-6 text-sm text-ink-3">
                          {readout(arm, experiment).map((part) => (
                            <span key={part}>{part}</span>
                          ))}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <ArmKindBadge kind={arm.kind} />
                    </TableCell>
                    <TableCell>
                      {arm.control_type ? CONTROL_TYPE_LABEL[arm.control_type] : NONE}
                      {arm.protein_override !== null ? (
                        <span className="block text-sm text-ink-3">{format.quantity(arm.protein_override, "mg/mL")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>{solventText(arm.solvent, arm.solvent_percentage) ?? NONE}</TableCell>
                    <TableCell>{arm.omitted_cofactor ? (arm.omitted_cofactor === "all" ? "Every cofactor" : arm.omitted_cofactor) : NONE}</TableCell>
                    <TableCell className="pr-5">{arm.kind === "negative_control" ? <Reference arm={arm} /> : NONE}</TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function Arms({ experiment, styles }: { experiment: Experiment; styles: ReadonlyMap<string, ArmStyle> }) {
  const arms = experiment.arms.filter((arm) => arm.modulator_id !== null);
  return (
    <section aria-labelledby="arms-heading" className="rounded-lg border border-rule bg-surface">
      <div className="px-5 pt-4 pb-2">
        <h2 id="arms-heading" className="text-base font-bold">
          Arms
        </h2>
        <p className="text-sm text-ink-3">
          {experiment.sampling === "endpoint"
            ? "Each condition is read once, at the end of the last stage."
            : "Each arm is incubated in replicate at every timepoint."}
        </p>
      </div>
      {arms.length === 0 ? (
        <p className="px-5 pb-4 text-ink-3">No inhibitor arms.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Arm</TableHead>
              <TableHead className="text-right">Concentration</TableHead>
              <TableHead>Solvent</TableHead>
              <TableHead>Cofactor</TableHead>
              <TableHead>Compared against</TableHead>
              <TableHead className="pr-5">Inhibitor lot</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byStage(arms, experiment.stages.length).map((group) => (
              <Fragment key={group.stage ?? "only"}>
                <StageRow stage={group.stage} columns={6} />
                {group.rows.map((arm) => (
                  <TableRow key={arm.key} className="align-top">
                    <TableCell className="pl-5">
                      <Label arm={arm} style={styles.get(arm.key)} />
                      <span className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-sm text-ink-3">
                        <ArmKindBadge kind={arm.kind} />
                        {arm.target_enzymes.length > 0 ? <span>{arm.target_enzymes.join(", ")}</span> : null}
                        {readout(arm, experiment).map((part) => (
                          <span key={part}>{part}</span>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Concentration arm={arm} stages={experiment.stages} />
                    </TableCell>
                    <TableCell>{solventText(arm.solvent, arm.solvent_percentage) ?? NONE}</TableCell>
                    <TableCell>
                      {arm.cofactor_omitted ? `Without ${arm.omitted_cofactor === "all" ? "any cofactor" : arm.omitted_cofactor}` : "Present"}
                    </TableCell>
                    <TableCell>
                      <Reference arm={arm} />
                    </TableCell>
                    <TableCell className="pr-5">
                      {arm.lot ? (
                        <span className="flex flex-col items-start gap-1">
                          <span>
                            <span className="font-bold tracking-wide">{arm.lot.lot_number}</span>{" "}
                            <span className="text-ink-3">expires {format.date(arm.lot.expiry_date) ?? "unknown"}</span>
                          </span>
                          <ValidAtUseBadge valid={arm.lot.valid_at_use} />
                        </span>
                      ) : (
                        NONE
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function Protocol({ protocol }: { protocol: Schemas["ProtocolOut"] | null }) {
  return (
    <Card className="lg:col-span-8">
      <CardHeader>
        <CardTitle>
          <h2>Protocol</h2>
        </CardTitle>
        {protocol ? (
          <p className="text-[0.9375rem]">
            <span className="font-bold tracking-wide">{protocol.code ?? "No code"}</span>{" "}
            <span className="text-ink-2">version {protocol.version}</span>
            <span className="block text-ink-2">{protocol.name}</span>
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {!protocol ? (
          <p className="text-ink-3">No protocol linked to this experiment.</p>
        ) : protocol.steps.length === 0 ? (
          <p className="text-ink-3">This protocol has no steps recorded.</p>
        ) : (
          <ol className="divide-y divide-rule border-y border-rule">
            {protocol.steps.map((step) => (
              <li key={step.step_number} className="flex items-baseline gap-4 py-2.5">
                <span className="w-6 shrink-0 text-right font-bold text-ink-3 tabular-nums">{step.step_number}</span>
                <span className="flex-1 leading-snug">{step.instruction}</span>
                {step.duration !== null ? (
                  <span className="shrink-0 rounded-md bg-neutral-bg px-2 py-0.5 text-sm font-bold text-neutral-fg tabular-nums">
                    {format.quantity(step.duration, step.duration_unit)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

const ROLE_TONE = { major: "progress", minor: "neutral" } as const;

function Pathways({ enzymes }: { enzymes: Schemas["EnzymeRole"][] }) {
  return (
    <Card className="self-start lg:col-span-4">
      <CardHeader>
        <CardTitle>
          <h2>Expected enzyme pathways</h2>
        </CardTitle>
        <p className="text-sm text-ink-3">What the design expects each enzyme to contribute.</p>
      </CardHeader>
      <CardContent>
        {enzymes.length === 0 ? (
          <p className="text-ink-3">No expected pathways recorded.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {enzymes.map((enzyme) => (
              <li key={enzyme.enzyme} className="flex items-center justify-between gap-3 py-2.5">
                <span>
                  <span className="font-bold">{enzyme.enzyme}</span>
                  {enzyme.organ_context ? <span className="ml-2 text-sm text-ink-3">{enzyme.organ_context}</span> : null}
                </span>
                {enzyme.pathway_role ? (
                  <ToneBadge
                    tone={enzyme.pathway_role === "major" || enzyme.pathway_role === "minor" ? ROLE_TONE[enzyme.pathway_role] : "neutral"}
                  >
                    {format.humanize(enzyme.pathway_role)}
                  </ToneBadge>
                ) : (
                  <span className="text-sm text-ink-3">Role not set</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
