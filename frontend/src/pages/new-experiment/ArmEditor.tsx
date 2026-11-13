import { X } from "lucide-react";
import type { Schemas } from "@/api/client";
import { AddRowButton, Field, Input, RepeatGroup, Select, UnitInput, fieldId, listEditor, type ListEditor } from "@/components/form";
import { Button } from "@/components/ui/button";
import { ARM_ROLES, solventText } from "@/lib/domain";
import * as format from "@/lib/format";
import {
  EVERY_COFACTOR,
  MAX_ROWS,
  NO_SOLVENT,
  TYPED_SOLVENT,
  armRowCount,
  blankConcentration,
  blankTarget,
  controlLabel,
  omittableCofactors,
  referenceChoices,
  stageType,
  twinReferenceChoices,
  vehicleSolventChoices,
  type ArmDraft,
  type ExperimentDraft,
} from "./experiment-draft";
import { LotSelect } from "./LotSelect";

/** One inhibitor in one stage: its identity and the enzymes it blocks, its time in the stage, the solvent it is
 * dissolved in, the control it is compared against when its stage holds more than one, its concentrations, and
 * whether each concentration also runs without a cofactor. A single endpoint also plans each run's replicates. */
export function ArmEditor({
  draft,
  index,
  arm,
  arms,
  derived,
  lots,
  clearUnder,
  focusAfterRender,
  onRemove,
}: {
  draft: ExperimentDraft;
  index: number;
  arm: ArmDraft;
  arms: ListEditor<ArmDraft>;
  derived: ReadonlyMap<number, string>;
  lots: readonly Schemas["ReagentLotRow"][];
  clearUnder: (prefix: string) => void;
  focusAfterRender: (id: string) => void;
  onRemove: () => void;
}) {
  const path = `arms.${index}`;
  const concentrations = listEditor({
    path: `${path}.concentrations`,
    rows: arm.concentrations,
    firstField: "concentration",
    clearUnder,
    focusAfterRender,
    setRows: (change) => arms.updateWith(index, (row) => ({ ...row, concentrations: change(row.concentrations) })),
  });
  const alsoTargets = listEditor({
    path: `${path}.also_targets`,
    rows: arm.also_targets,
    firstField: "enzyme",
    clearUnder,
    focusAfterRender,
    setRows: (change) => arms.updateWith(index, (row) => ({ ...row, also_targets: change(row.also_targets) })),
  });
  const stageIndex = Math.max(
    draft.stages.findIndex((stage) => stage.key === arm.stage),
    0,
  );
  const stageName = stageType(stageIndex);
  const stageMinutes = draft.stages[stageIndex]?.incubation_minutes.trim() ?? "";
  const endpoint = draft.sampling === "endpoint";
  const references = referenceChoices(draft, arm.stage);
  const twinReferences = twinReferenceChoices(draft, arm.stage, arm.omitted_cofactor);
  const solventChoices = vehicleSolventChoices(draft, arm.stage, derived);
  const staleSolvent = arm.solvent.startsWith("vehicle:") && !solventChoices.some((choice) => choice.value === arm.solvent);
  const cofactors = omittableCofactors(draft);
  const rowsLeft = MAX_ROWS.armRows - armRowCount(draft.arms);
  const inheritedSolvent = solventText(draft.condition.solvent.trim(), Number(draft.condition.solvent_percentage) || null);
  const omittedName =
    arm.omitted_cofactor === EVERY_COFACTOR
      ? "every cofactor"
      : cofactors.find((row) => String(row.key) === arm.omitted_cofactor)?.cofactor.trim();
  const twinHasReference = draft.controls.some(
    (control) =>
      control.stage === arm.stage && control.control_type === "minus_cofactor" && control.omitted_cofactor === arm.omitted_cofactor,
  );
  const several = arm.concentrations.length > 1;

  return (
    <RepeatGroup
      title={`Arm ${index + 1}${arm.inhibitor.trim() ? `, ${arm.inhibitor.trim()}` : ""}`}
      removeLabel={`Remove arm ${index + 1}`}
      onRemove={onRemove}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
        <Field path={`${path}.inhibitor`} label="Inhibitor" required>
          {(field) => (
            <Input
              {...field}
              list="compound-names"
              value={arm.inhibitor}
              onChange={(event) => arms.update(index, { inhibitor: event.target.value })}
            />
          )}
        </Field>
        <Field path={`${path}.role`} label="Role">
          {(field) => (
            <Select
              {...field}
              value={arm.role}
              onChange={(event) => {
                const role = ARM_ROLES.find((option) => option === event.target.value);
                if (role) arms.update(index, { role });
              }}
            >
              {ARM_ROLES.map((role) => (
                <option key={role} value={role}>
                  {format.humanize(role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field path={`${path}.target_enzyme`} label="Target enzyme">
          {(field) => (
            <Input
              {...field}
              list="enzyme-names"
              value={arm.target_enzyme}
              onChange={(event) => arms.update(index, { target_enzyme: event.target.value })}
            />
          )}
        </Field>
        <Field path={`${path}.reagent_lot_id`} label="Lot">
          {(field) => (
            <LotSelect
              {...field}
              lots={lots}
              preferred={arm.inhibitor}
              value={arm.reagent_lot_id}
              onChange={(value) => arms.update(index, { reagent_lot_id: value })}
            />
          )}
        </Field>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-ink-2">Also targets</legend>
        <div className="mt-1 flex flex-wrap items-start gap-3">
          {arm.also_targets.map((entry, at) => (
            <div key={entry.key} className="flex items-start gap-1">
              <Field path={`${path}.also_targets.${at}.enzyme`} label={`Also target ${at + 1}`} required className="w-40">
                {(field) => (
                  <Input
                    {...field}
                    list="enzyme-names"
                    value={entry.enzyme}
                    onChange={(event) => alsoTargets.update(at, { enzyme: event.target.value })}
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => alsoTargets.remove(at)}
                aria-label={`Remove also target ${at + 1}`}
                className="mt-6 text-ink-2"
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <div className={arm.also_targets.length > 0 ? "mt-6" : undefined}>
            <AddRowButton
              path={`${path}.also_targets`}
              full={arm.also_targets.length >= MAX_ROWS.alsoTargets}
              fullNote="That is the most one inhibitor can name."
              onClick={() => alsoTargets.add(blankTarget())}
            >
              Add target
            </AddRowButton>
          </div>
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        {draft.stages.length > 1 ? (
          <Field path={`${path}.stage`} label="Stage it enters" className="w-44">
            {(field) => (
              <Select {...field} value={String(arm.stage)} onChange={(event) => arms.update(index, { stage: Number(event.target.value) })}>
                {draft.stages.map((stage, at) => (
                  <option key={stage.key} value={String(stage.key)}>
                    {format.humanize(stageType(at))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field path={`${path}.incubation_minutes`} label="Time in its stage" className="w-36">
          {(field) => (
            <UnitInput
              {...field}
              unit="min"
              placeholder={stageMinutes}
              value={arm.incubation_minutes}
              onChange={(event) => arms.update(index, { incubation_minutes: event.target.value })}
            />
          )}
        </Field>
        {endpoint ? (
          <Field path={`${path}.replicates`} label="Replicates" required className="w-28">
            {(field) => (
              <Input
                {...field}
                inputMode="numeric"
                value={arm.replicates}
                onChange={(event) => arms.update(index, { replicates: event.target.value })}
                className="tabular-nums"
              />
            )}
          </Field>
        ) : null}
        <Field path={`${path}.solvent`} label="Solvent" className="w-72">
          {(field) => (
            <Select {...field} value={arm.solvent} onChange={(event) => arms.update(index, { solvent: event.target.value })}>
              {staleSolvent ? (
                <option value={arm.solvent} disabled>
                  Choose again: its vehicle changed
                </option>
              ) : null}
              <option value="">{inheritedSolvent ? `As the incubation, ${inheritedSolvent}` : "As the incubation"}</option>
              {solventChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
              <option value={NO_SOLVENT}>None, aqueous</option>
              <option value={TYPED_SOLVENT}>Another solvent</option>
            </Select>
          )}
        </Field>
        {arm.solvent === TYPED_SOLVENT ? (
          <>
            <Field path={`${path}.typed_solvent`} label="Solvent name" required className="w-40">
              {(field) => (
                <Input {...field} value={arm.typed_solvent} onChange={(event) => arms.update(index, { typed_solvent: event.target.value })} />
              )}
            </Field>
            <Field path={`${path}.solvent_percentage`} label="Solvent, final" className="w-32">
              {(field) => (
                <UnitInput
                  {...field}
                  unit="%"
                  value={arm.solvent_percentage}
                  onChange={(event) => arms.update(index, { solvent_percentage: event.target.value })}
                />
              )}
            </Field>
          </>
        ) : null}
        {references.length > 1 ? (
          <Field
            path={`${path}.reference_control`}
            label="Compared against"
            hint={arm.reference_control ? undefined : "The control in the arm's solvent."}
            className="w-64"
          >
            {(field) => (
              <Select
                {...field}
                value={arm.reference_control}
                onChange={(event) => arms.update(index, { reference_control: event.target.value })}
              >
                {arm.reference_control && !references.some((control) => String(control.key) === arm.reference_control) ? (
                  <option value={arm.reference_control} disabled>
                    Choose again: that control changed
                  </option>
                ) : null}
                <option value="">Matched by solvent</option>
                {references.map((control) => (
                  <option key={control.key} value={String(control.key)}>
                    {controlLabel(control, derived)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-ink-2">Concentrations, µM</legend>
        <div className="mt-1 flex flex-wrap items-start gap-3">
          {arm.concentrations.map((entry, at) => (
            <div key={entry.key} className="flex items-start gap-1">
              <Field path={`${path}.concentrations.${at}.concentration`} label={`Concentration ${at + 1}`} className="w-32">
                {(field) => (
                  <UnitInput
                    {...field}
                    unit="µM"
                    value={entry.concentration}
                    onChange={(event) => concentrations.update(at, { concentration: event.target.value })}
                  />
                )}
              </Field>
              {several ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => concentrations.remove(at)}
                  aria-label={`Remove concentration ${at + 1}`}
                  className="mt-6 text-ink-2"
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          <div className="mt-6">
            <AddRowButton
              path={`${path}.concentrations`}
              full={rowsLeft < (arm.without_cofactor ? 2 : 1)}
              onClick={() => concentrations.add(blankConcentration())}
            >
              Add concentration
            </AddRowButton>
          </div>
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <label className="mt-6 flex h-9 cursor-pointer items-center gap-2 text-[0.9375rem]">
          <input
            id={fieldId(`${path}.without_cofactor`)}
            type="checkbox"
            checked={arm.without_cofactor}
            disabled={!arm.without_cofactor && (cofactors.length === 0 || rowsLeft < arm.concentrations.length)}
            onChange={(event) =>
              arms.update(index, {
                without_cofactor: event.target.checked,
                omitted_cofactor: arm.omitted_cofactor || String(cofactors[0]?.key ?? EVERY_COFACTOR),
              })
            }
            className="size-4 cursor-pointer accent-ink"
          />
          Also run each concentration without a cofactor
        </label>
        {arm.without_cofactor ? (
          <Field
            path={`${path}.omitted_cofactor`}
            label="Cofactor left out"
            hint={
              omittedName && !twinHasReference
                ? `Add a control to the ${stageName} stage that leaves out ${omittedName}, so these runs have a reference.`
                : undefined
            }
            className="w-72"
          >
            {(field) => (
              <Select {...field} value={arm.omitted_cofactor} onChange={(event) => arms.update(index, { omitted_cofactor: event.target.value })}>
                {arm.omitted_cofactor !== EVERY_COFACTOR && !cofactors.some((row) => String(row.key) === arm.omitted_cofactor) ? (
                  <option value={arm.omitted_cofactor} disabled>
                    Choose a cofactor
                  </option>
                ) : null}
                {cofactors.map((cofactor) => (
                  <option key={cofactor.key} value={String(cofactor.key)}>
                    {cofactor.cofactor.trim()}
                  </option>
                ))}
                <option value={EVERY_COFACTOR}>Every cofactor</option>
              </Select>
            )}
          </Field>
        ) : cofactors.length === 0 ? (
          <p className="mt-8 text-sm text-ink-3">Give a component the cofactor role to run without it.</p>
        ) : null}
        {arm.without_cofactor && endpoint ? (
          <Field path={`${path}.twin_replicates`} label="Replicates without cofactor" required className="w-52">
            {(field) => (
              <Input
                {...field}
                inputMode="numeric"
                value={arm.twin_replicates}
                onChange={(event) => arms.update(index, { twin_replicates: event.target.value })}
                className="tabular-nums"
              />
            )}
          </Field>
        ) : null}
        {arm.without_cofactor && twinReferences.length > 1 ? (
          <Field
            path={`${path}.twin_reference_control`}
            label="Runs without cofactor compared against"
            hint={arm.twin_reference_control ? undefined : "The control in the arm's solvent."}
            className="w-72"
          >
            {(field) => (
              <Select
                {...field}
                value={arm.twin_reference_control}
                onChange={(event) => arms.update(index, { twin_reference_control: event.target.value })}
              >
                {arm.twin_reference_control && !twinReferences.some((control) => String(control.key) === arm.twin_reference_control) ? (
                  <option value={arm.twin_reference_control} disabled>
                    Choose again: that control changed
                  </option>
                ) : null}
                <option value="">Matched by solvent</option>
                {twinReferences.map((control) => (
                  <option key={control.key} value={String(control.key)}>
                    {controlLabel(control, derived)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </RepeatGroup>
  );
}
