import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import {
  AddRowButton,
  Field,
  FieldProblems,
  FormSection,
  Input,
  LeaveWarning,
  NumberWithUnit,
  ProblemAlert,
  RepeatGroup,
  RequiredNote,
  Select,
  UnitInput,
  addRowId,
  fieldId,
  listEditor,
  useFocusAfterRender,
  useFormProblems,
  useLeaveGuard,
} from "@/components/form";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ADDITION_STEP_LABEL, ADDITION_STEPS, INTERNAL_STANDARD_UNITS, LOT_FLAG, SAMPLING_LABEL, SAMPLINGS } from "@/lib/domain";
import { sameName } from "@/lib/drafts";
import { withFlash } from "@/lib/flash";
import * as format from "@/lib/format";
import { ArmEditor } from "./ArmEditor";
import { ComponentEditor } from "./ComponentEditor";
import {
  armRowCount,
  blankArm,
  blankCofactor,
  blankControl,
  blankExperiment,
  blankPathway,
  blankStage,
  derivedControlLabels,
  expectedProtein,
  experimentBody,
  isHepatocyteStudy,
  isLotOf,
  MAX_ROWS,
  armRowOrigins,
  formArmPath,
  stageType,
  type ConditionDraft,
  type ExperimentDraft,
  type InternalStandardDraft,
} from "./experiment-draft";
import { LotSelect } from "./LotSelect";
import { StageControls } from "./StageControls";

type Reference = Schemas["ReferenceData"];

export function NewExperimentPage() {
  const reference = useQuery(queries.reference());
  const me = useQuery(queries.me());
  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
          <Link to="/experiments" className="font-bold text-ballpoint underline-offset-2 hover:underline">
            Experiments
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span aria-current="page">New experiment</span>
        </nav>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold">Plan an experiment</h1>
        <p className="mt-1 max-w-[72ch] text-ink-2">
          It is saved as planned. Bench data comes next, pasted on its Bench data tab.
        </p>
      </header>
      {reference.isPending || me.isPending ? (
        <Loading label="Loading compounds, lots and lab members…" />
      ) : reference.isError ? (
        <ErrorState title="The form's choices could not load" error={reference.error} onRetry={() => reference.refetch()} />
      ) : (
        <ExperimentForm
          reference={reference.data}
          initial={blankExperiment({ memberId: me.data?.member_id ?? null })}
          save={mutations.createExperiment}
          wording={CREATE_WORDING}
          cancelTo="/experiments"
          onSaved={(experiment, navigate) =>
            navigate(`/experiments/${experiment.id}/bench`, {
              state: withFlash({ kind: "experiment-planned", experimentId: experiment.id }),
            })
          }
        />
      )}
    </div>
  );
}

type Wording = { submit: string; pending: string; failed: string; leaving: string };
const CREATE_WORDING: Wording = {
  submit: "Create experiment",
  pending: "Creating…",
  failed: "The experiment was not created",
  leaving: "The new experiment",
};
export const EDIT_WORDING: Wording = {
  submit: "Save changes",
  pending: "Saving…",
  failed: "The changes were not saved",
  leaving: "The changes to this experiment",
};

/** The experiment form, for a new experiment or for changing the design of one that has no bench data yet. */
export function ExperimentForm({
  reference,
  initial,
  save,
  wording,
  cancelTo,
  onSaved,
}: {
  reference: Reference;
  initial: ExperimentDraft;
  save: (body: Schemas["ExperimentIn"]) => Promise<Schemas["ExperimentDetail"]>;
  wording: Wording;
  cancelTo: string;
  onSaved: (experiment: Schemas["ExperimentDetail"], navigate: ReturnType<typeof useNavigate>) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const memberId = useQuery(queries.me()).data?.member_id ?? null;
  const [draft, setDraft] = useState(initial);
  const problems = useFormProblems();
  const guard = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial));
  const focusAfterRender = useFocusAfterRender();

  const create = useMutation({
    mutationFn: save,
    onSuccess: async (experiment) => {
      queryClient.setQueryData(queries.experiment(experiment.id).queryKey, experiment);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["experiments"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["reference"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory", "tissue-lots"] }),
      ]);
      guard.allowLeave();
      onSaved(experiment, navigate);
    },
    // The API counts arms one row per concentration; its problems go back to the arm and concentration they came from.
    onError: (error) => problems.showServerErrorAt(error, (path) => formArmPath(path, origins.current)),
  });

  const origins = useRef<{ arm: number; concentration: number }[]>([]);

  function submit(event: FormEvent) {
    event.preventDefault();
    origins.current = armRowOrigins(draft);
    const parsed = experimentBody(draft, reference.reagent_lots);
    if (parsed.ok) create.mutate(parsed.body);
    else problems.showFieldErrors(parsed.errors);
  }

  function set<K extends keyof ExperimentDraft>(key: K, value: ExperimentDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setStandard(patch: Partial<InternalStandardDraft>) {
    setDraft((current) => ({ ...current, internal_standard: { ...current.internal_standard, ...patch } }));
  }

  function setCondition(key: keyof ConditionDraft, value: string) {
    setDraft((current) => ({ ...current, condition: { ...current.condition, [key]: value } }));
  }

  const lists = { clearUnder: problems.clearUnder, focusAfterRender };
  const cofactorRows = listEditor({
    ...lists,
    path: "cofactors",
    rows: draft.cofactors,
    firstField: "cofactor",
    setRows: (update) => setDraft((current) => ({ ...current, cofactors: update(current.cofactors) })),
  });
  const armRows = listEditor({
    ...lists,
    path: "arms",
    rows: draft.arms,
    firstField: "inhibitor",
    setRows: (update) => setDraft((current) => ({ ...current, arms: update(current.arms) })),
  });
  const controlRows = listEditor({
    ...lists,
    path: "controls",
    rows: draft.controls,
    firstField: "control_type",
    setRows: (update) => setDraft((current) => ({ ...current, controls: update(current.controls) })),
  });
  const stageRows = listEditor({
    ...lists,
    path: "stages",
    rows: draft.stages,
    firstField: "dilution_factor",
    setRows: (update) => setDraft((current) => ({ ...current, stages: update(current.stages) })),
  });
  const pathwayRows = listEditor({
    ...lists,
    path: "pathways",
    rows: draft.pathways,
    firstField: "enzyme",
    setRows: (update) => setDraft((current) => ({ ...current, pathways: update(current.pathways) })),
  });

  /** A new stage starts with a vehicle control of its own. */
  function addStage() {
    const stage = blankStage();
    setDraft((current) => ({ ...current, stages: [...current.stages, stage], controls: [...current.controls, blankControl(stage.key)] }));
    focusAfterRender(fieldId(`stages.${draft.stages.length}.dilution_factor`));
  }

  /** A stage's controls go with it. A stage that still holds arms cannot be removed, so no arm moves unseen. */
  function removeStage(index: number) {
    const key = draft.stages[index]?.key;
    stageRows.remove(index);
    setDraft((current) => ({ ...current, controls: current.controls.filter((control) => control.stage !== key) }));
    problems.clearUnder("controls");
  }

  function removeControl(index: number, stageIndex: number) {
    controlRows.remove(index);
    problems.clearUnder("arms");
    focusAfterRender(addRowId(`stages.${stageIndex}.controls`));
  }

  const hepatocytes = isHepatocyteStudy(draft.study_type);
  const knownSubstrate = reference.compounds.some((compound) => sameName(compound.name, draft.substrate));
  const standardName = draft.internal_standard.compound;
  const standardIsNew = standardName.trim() !== "" && !reference.compounds.some((compound) => sameName(compound.name, standardName));
  const lots = reference.reagent_lots;
  const derived = derivedControlLabels(draft);
  const armRowTotal = armRowCount(draft.arms);

  return (
    <FieldProblems errors={problems.fields} clear={problems.clear}>
      <form ref={problems.formRef} onSubmit={submit} noValidate className="space-y-6">
        <LeaveWarning blocker={guard.blocker} what={wording.leaving} />
        <ProblemAlert title={wording.failed} message={problems.general} alertRef={problems.alertRef} />
        <RequiredNote />

        <datalist id="compound-names">
          {reference.compounds.map((compound) => (
            <option key={compound.id} value={compound.name} />
          ))}
        </datalist>
        <datalist id="enzyme-names">
          {reference.enzymes.map((enzyme) => (
            <option key={enzyme.id} value={enzyme.name} />
          ))}
        </datalist>

        <FormSection title="Basics">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Field path="title" label="Title" required className="md:col-span-2">
              {(control) => <Input {...control} value={draft.title} onChange={(event) => set("title", event.target.value)} />}
            </Field>
            <Field path="study_type" label="Study type" required>
              {(control) => (
                <Select
                  {...control}
                  value={draft.study_type}
                  onChange={(event) => set("study_type", reference.study_types.find((type) => type === event.target.value) ?? "")}
                >
                  <option value="" disabled>
                    Choose a study type
                  </option>
                  {reference.study_types.map((type) => (
                    <option key={type} value={type}>
                      {format.humanize(type)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path="experiment_date" label="Date" hint="Used to check lot expiry.">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={draft.experiment_date}
                  onChange={(event) => set("experiment_date", event.target.value)}
                />
              )}
            </Field>
            <Field path="performed_by" label="Performed by">
              {(control) => (
                <Select {...control} value={draft.performed_by} onChange={(event) => set("performed_by", event.target.value)}>
                  {memberId === null ? <option value="">Signed-in member</option> : null}
                  {reference.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                      {member.id === memberId ? " (you)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path="protocol_id" label="Protocol" className="md:col-span-2">
              {(control) => (
                <Select {...control} value={draft.protocol_id} onChange={(event) => set("protocol_id", event.target.value)}>
                  <option value="">No protocol</option>
                  {reference.protocols.map((protocol) => (
                    <option key={protocol.id} value={protocol.id}>
                      {protocol.code ? `${protocol.code} v${protocol.version}, ` : ""}
                      {protocol.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path="code" label="Experiment code" hint="Leave empty to get the next WL code.">
              {(control) => (
                <Input
                  {...control}
                  value={draft.code}
                  onChange={(event) => set("code", event.target.value)}
                  className="tracking-wide"
                />
              )}
            </Field>
            <Field path="objective" label="Objective" className="md:col-span-2 lg:col-span-4">
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  value={draft.objective}
                  onChange={(event) => set("objective", event.target.value)}
                  className="text-[0.9375rem] md:text-[0.9375rem]"
                />
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection title="Substrate and enzyme source">
          <div className="grid gap-4 md:grid-cols-3">
            <Field
              path="substrate"
              label="Substrate"
              required
              hint={draft.substrate.trim() && !knownSubstrate ? "A new compound. It is added to the list." : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  list="compound-names"
                  value={draft.substrate}
                  onChange={(event) => set("substrate", event.target.value)}
                />
              )}
            </Field>
            <Field
              path="substrate_reagent_lot_id"
              label="Substrate lot"
              hint={
                draft.substrate.trim() && lots.some((lot) => isLotOf(lot, draft.substrate))
                  ? `Lots of ${draft.substrate.trim()} are listed first.`
                  : undefined
              }
            >
              {(control) => (
                <LotSelect
                  {...control}
                  lots={lots}
                  preferred={draft.substrate}
                  value={draft.substrate_reagent_lot_id}
                  onChange={(value) => set("substrate_reagent_lot_id", value)}
                />
              )}
            </Field>
            <Field path="tissue_lot_id" label="Tissue lot">
              {(control) => (
                <Select {...control} value={draft.tissue_lot_id} onChange={(event) => set("tissue_lot_id", event.target.value)}>
                  <option value="">No tissue lot</option>
                  {reference.tissue_lots.map((lot) => (
                    <option key={lot.id} value={lot.id}>
                      {tissueLotLabel(lot)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Stages"
          description="One block per incubation, in order, with the controls run in it. A later stage can start as a dilution of the stage before it."
        >
          <Field path="sampling" label="Sampling" hint="A single endpoint is read once, at the end of the last stage." className="w-64">
            {(control) => (
              <Select
                {...control}
                value={draft.sampling}
                onChange={(event) => set("sampling", SAMPLINGS.find((sampling) => sampling === event.target.value) ?? "time_course")}
              >
                {SAMPLINGS.map((sampling) => (
                  <option key={sampling} value={sampling}>
                    {SAMPLING_LABEL[sampling]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {draft.stages.map((row, index) => {
            const type = stageType(index);
            const previous = index > 0 ? draft.stages[index - 1] : undefined;
            const expected = previous && !hepatocytes ? expectedProtein(previous.protein_concentration, row.dilution_factor) : null;
            return (
              <RepeatGroup
                key={row.key}
                title={`${format.humanize(type)} stage`}
                removeLabel={`Remove the ${type} stage`}
                onRemove={
                  index > 0 && index === draft.stages.length - 1 && !draft.arms.some((arm) => arm.stage === row.key)
                    ? () => removeStage(index)
                    : undefined
                }
              >
                {index > 0 && index === draft.stages.length - 1 && draft.arms.some((arm) => arm.stage === row.key) ? (
                  <p className="mb-2 text-sm text-ink-3">To remove this stage, move its arms to another stage or remove them.</p>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {previous ? (
                    <Field path={`stages.${index}.dilution_factor`} label={`Dilution from the ${stageType(index - 1)} stage`}>
                      {(control) => (
                        <UnitInput
                          {...control}
                          unit="fold"
                          value={row.dilution_factor}
                          onChange={(event) => stageRows.update(index, { dilution_factor: event.target.value })}
                        />
                      )}
                    </Field>
                  ) : null}
                  <Field path={`stages.${index}.incubation_minutes`} label="Incubation">
                    {(control) => (
                      <UnitInput
                        {...control}
                        unit="min"
                        value={row.incubation_minutes}
                        onChange={(event) => stageRows.update(index, { incubation_minutes: event.target.value })}
                      />
                    )}
                  </Field>
                  {hepatocytes ? (
                    <Field path={`stages.${index}.cell_density`} label="Cell density">
                      {(control) => (
                        <UnitInput
                          {...control}
                          unit={
                            <>
                              ×10<sup>6</sup>&nbsp;cells/mL
                            </>
                          }
                          value={row.cell_density}
                          onChange={(event) => stageRows.update(index, { cell_density: event.target.value })}
                        />
                      )}
                    </Field>
                  ) : (
                    <Field
                      path={`stages.${index}.protein_concentration`}
                      label="Protein"
                      hint={expected !== null ? `The dilution gives ${format.plain(expected)} mg/mL.` : undefined}
                    >
                      {(control) => (
                        <UnitInput
                          {...control}
                          unit="mg/mL"
                          value={row.protein_concentration}
                          onChange={(event) => stageRows.update(index, { protein_concentration: event.target.value })}
                        />
                      )}
                    </Field>
                  )}
                </div>
                <StageControls
                  draft={draft}
                  stage={row.key}
                  stageName={type}
                  addPath={`stages.${index}.controls`}
                  derived={derived}
                  controls={controlRows}
                  onRemove={(at) => removeControl(at, index)}
                />
              </RepeatGroup>
            );
          })}
          <AddRowButton
            path="stages"
            full={draft.stages.length >= MAX_ROWS.stages || draft.controls.length >= MAX_ROWS.controls}
            onClick={addStage}
          >
            Add stage
          </AddRowButton>
        </FormSection>

        <FormSection title="Incubation conditions">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ConditionNumber path="incubation_temperature" label="Temperature" unit="°C" draft={draft.condition} onChange={setCondition} />
            <ConditionNumber path="preincubation_time" label="Preincubation" unit="min" draft={draft.condition} onChange={setCondition} />
            <Field path="condition.buffer" label="Buffer">
              {(control) => (
                <Input {...control} value={draft.condition.buffer} onChange={(event) => setCondition("buffer", event.target.value)} />
              )}
            </Field>
            <Field path="condition.ph" label="pH">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={draft.condition.ph}
                  onChange={(event) => setCondition("ph", event.target.value)}
                  className="tabular-nums"
                />
              )}
            </Field>
            <Field path="condition.solvent" label="Solvent">
              {(control) => (
                <Input {...control} value={draft.condition.solvent} onChange={(event) => setCondition("solvent", event.target.value)} />
              )}
            </Field>
            <ConditionNumber path="solvent_percentage" label="Solvent, final" unit="% v/v" draft={draft.condition} onChange={setCondition} />
            <Field
              path="condition.fu_inc"
              label={
                <>
                  f<sub>u,inc</sub>
                </>
              }
              hint="Fraction unbound in the incubation, 0 to 1."
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={draft.condition.fu_inc}
                  onChange={(event) => setCondition("fu_inc", event.target.value)}
                  className="tabular-nums"
                />
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Components"
          description="Cofactors, solvents and anything else added besides the substrate and the enzyme source, each with its role. A minus-cofactor control can leave out only a component whose role is cofactor."
        >
          {draft.cofactors.length === 0 ? <p className="text-ink-3">No components listed yet.</p> : null}
          {draft.cofactors.map((row, index) => (
            <ComponentEditor
              key={row.key}
              index={index}
              row={row}
              rows={cofactorRows}
              lots={lots}
              members={reference.members}
              solutions={reference.prepared_solutions}
              onRemove={() => cofactorRows.remove(index)}
            />
          ))}
          <AddRowButton path="cofactors" full={draft.cofactors.length >= MAX_ROWS.cofactors} onClick={() => cofactorRows.add(blankCofactor())}>
            Add component
          </AddRowButton>
        </FormSection>

        <FormSection
          title="Internal standard"
          description="Added to every sample to normalise the LC-MS signal. Leave the compound empty if the run has none."
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_12rem_minmax(0,1fr)_minmax(0,1fr)]">
            <Field
              path="internal_standard.compound"
              label="Compound"
              hint={standardIsNew ? "A new compound. It is added to the list." : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  list="compound-names"
                  value={draft.internal_standard.compound}
                  onChange={(event) => setStandard({ compound: event.target.value })}
                />
              )}
            </Field>
            <Field path="internal_standard.concentration" label="Concentration">
              {(control) => (
                <NumberWithUnit
                  {...control}
                  value={draft.internal_standard.concentration}
                  onChange={(event) => setStandard({ concentration: event.target.value })}
                  unitLabel="Internal standard unit"
                  unitValue={draft.internal_standard.concentration_unit}
                  units={INTERNAL_STANDARD_UNITS.map((value) => ({ value, label: format.unit(value) }))}
                  onUnitChange={(value) => {
                    const unit = INTERNAL_STANDARD_UNITS.find((option) => option === value);
                    if (unit) setStandard({ concentration_unit: unit });
                  }}
                />
              )}
            </Field>
            <Field path="internal_standard.addition_step" label="Added">
              {(control) => (
                <Select
                  {...control}
                  value={draft.internal_standard.addition_step}
                  onChange={(event) => {
                    const step = ADDITION_STEPS.find((option) => option === event.target.value);
                    if (step) setStandard({ addition_step: step });
                  }}
                >
                  {ADDITION_STEPS.map((step) => (
                    <option key={step} value={step}>
                      {ADDITION_STEP_LABEL[step]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path="internal_standard.solvent" label="In">
              {(control) => (
                <Input
                  {...control}
                  value={draft.internal_standard.solvent}
                  onChange={(event) => setStandard({ solvent: event.target.value })}
                />
              )}
            </Field>
            <Field path="internal_standard.reagent_lot_id" label="Lot" className="sm:col-span-2">
              {(control) => (
                <LotSelect
                  {...control}
                  lots={lots}
                  preferred={draft.internal_standard.compound}
                  value={draft.internal_standard.reagent_lot_id}
                  onChange={(value) => setStandard({ reagent_lot_id: value })}
                />
              )}
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Inhibitor arms"
          description="Each arm is one inhibitor in one stage, at one or more concentrations. It is compared against the control in its own solvent."
        >
          {draft.arms.map((arm, index) => (
            <ArmEditor
              key={arm.key}
              draft={draft}
              index={index}
              arm={arm}
              arms={armRows}
              derived={derived}
              lots={lots}
              clearUnder={problems.clearUnder}
              focusAfterRender={focusAfterRender}
              onRemove={() => armRows.remove(index)}
            />
          ))}
          {draft.arms.length > 0 ? (
            <p className="text-sm text-ink-3">
              An arm whose targets are all outside the expected pathways below is reported as a selectivity control. The
              arms make {armRowTotal} of the {MAX_ROWS.armRows} rows an experiment can hold, one per concentration and one per
              run without a cofactor.
            </p>
          ) : null}
          <AddRowButton
            path="arms"
            full={armRowTotal >= MAX_ROWS.armRows}
            onClick={() => armRows.add(blankArm(draft.study_type, draft.stages[0]?.key ?? 0))}
          >
            Add inhibitor arm
          </AddRowButton>
        </FormSection>

        <FormSection title="Expected enzyme pathways" description="What the design expects each enzyme to contribute.">
          {draft.pathways.length === 0 ? <p className="text-ink-3">No pathways listed yet.</p> : null}
          {draft.pathways.map((row, index) => (
            <RepeatGroup
              key={row.key}
              title={`Pathway ${index + 1}${row.enzyme.trim() ? `, ${row.enzyme.trim()}` : ""}`}
              removeLabel={`Remove pathway ${index + 1}`}
              onRemove={() => pathwayRows.remove(index)}
            >
              <div className="grid gap-4 sm:grid-cols-[minmax(0,18rem)_12rem]">
                <Field path={`pathways.${index}.enzyme`} label="Enzyme" required>
                  {(control) => (
                    <Input
                      {...control}
                      list="enzyme-names"
                      value={row.enzyme}
                      onChange={(event) => pathwayRows.update(index, { enzyme: event.target.value })}
                    />
                  )}
                </Field>
                <Field path={`pathways.${index}.pathway_role`} label="Role">
                  {(control) => (
                    <Select
                      {...control}
                      value={row.pathway_role}
                      onChange={(event) => {
                        const role = reference.pathway_roles.find((option) => option === event.target.value);
                        if (role) pathwayRows.update(index, { pathway_role: role });
                      }}
                    >
                      {reference.pathway_roles.map((role) => (
                        <option key={role} value={role}>
                          {format.humanize(role)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            </RepeatGroup>
          ))}
          <AddRowButton path="pathways" full={draft.pathways.length >= MAX_ROWS.pathways} onClick={() => pathwayRows.add(blankPathway())}>
            Add pathway
          </AddRowButton>
        </FormSection>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={create.isPending} className="px-4 font-bold">
            {create.isPending ? wording.pending : wording.submit}
          </Button>
          <Button asChild variant="outline" size="lg" className="px-4">
            <Link to={cancelTo}>Cancel</Link>
          </Button>
        </div>
      </form>
    </FieldProblems>
  );
}

function ConditionNumber({
  path,
  label,
  unit,
  draft,
  onChange,
}: {
  path: keyof ConditionDraft;
  label: string;
  unit: string;
  draft: ConditionDraft;
  onChange: (key: keyof ConditionDraft, value: string) => void;
}) {
  return (
    <Field path={`condition.${path}`} label={label}>
      {(control) => <UnitInput {...control} unit={unit} value={draft[path]} onChange={(event) => onChange(path, event.target.value)} />}
    </Field>
  );
}

function tissueLotLabel(lot: Schemas["TissueLotRow"]): string {
  const material = [lot.species, lot.material_type].filter(Boolean).join(" ");
  const details = [
    material || null,
    lot.number_of_donors !== null ? format.count(lot.number_of_donors, "donor") : null,
    ...lot.flags.map((flag) => LOT_FLAG[flag].label(lot).toLowerCase()),
  ].filter(Boolean);
  return `${lot.lot_number ?? `Lot ${lot.id}`}${details.length > 0 ? `, ${details.join(", ")}` : ""}`;
}
