import { X } from "lucide-react";
import { AddRowButton, Field, Input, Select, UnitInput, type ListEditor } from "@/components/form";
import { Button } from "@/components/ui/button";
import { CONTROL_TYPE_LABEL, CONTROL_TYPES } from "@/lib/domain";
import {
  EVERY_COFACTOR,
  MAX_ROWS,
  blankControl,
  controlLabel,
  isHepatocyteStudy,
  omittableCofactors,
  type ControlDraft,
  type ExperimentDraft,
} from "./experiment-draft";

/** The controls run in one stage, edited inside that stage's block. A row's fields follow its type: a
 * solvent for all but a complete incubation, the cofactor a minus-cofactor control leaves out, and a protein
 * level of its own for heat-inactivated and other controls. Every row has a time in the stage, and plans its
 * replicates in a single-endpoint experiment. A row left without a label shows the one the API will give it. */
export function StageControls({
  draft,
  stage,
  stageName,
  addPath,
  derived,
  controls,
  onRemove,
}: {
  draft: ExperimentDraft;
  stage: number;
  stageName: string;
  addPath: string;
  derived: ReadonlyMap<number, string>;
  controls: ListEditor<ControlDraft>;
  onRemove: (index: number) => void;
}) {
  const rows = draft.controls.flatMap((control, index) => (control.stage === stage ? [{ control, index }] : []));
  const cofactors = omittableCofactors(draft);
  const ownProtein = !isHepatocyteStudy(draft.study_type);
  const stageMinutes = draft.stages.find((row) => row.key === stage)?.incubation_minutes.trim() ?? "";
  return (
    <div className="mt-4 space-y-3 border-t border-rule pt-3">
      <h3 className="text-sm font-bold text-ink-2">Controls in the {stageName} stage</h3>
      {rows.length === 0 ? <p className="text-sm text-ink-3">No controls in this stage.</p> : null}
      {rows.map(({ control, index }) => {
        const path = `controls.${index}`;
        const type = control.control_type;
        const name = controlLabel(control, derived);
        return (
          <fieldset key={control.key} className="flex flex-wrap items-start gap-3">
            <legend className="sr-only">Control: {name}</legend>
            <Field path={`${path}.control_type`} label="Type" className="w-56">
              {(field) => (
                <Select
                  {...field}
                  value={type}
                  onChange={(event) => {
                    const next = CONTROL_TYPES.find((option) => option === event.target.value);
                    if (next) controls.update(index, { control_type: next });
                  }}
                >
                  {CONTROL_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {CONTROL_TYPE_LABEL[option]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path={`${path}.label`} label="Label" required={type === "other"} className="min-w-48 flex-1">
              {(field) => (
                <Input
                  {...field}
                  value={control.label}
                  placeholder={derived.get(control.key) ?? ""}
                  onChange={(event) => controls.update(index, { label: event.target.value })}
                />
              )}
            </Field>
            {type === "complete" ? null : (
              <>
                <Field path={`${path}.solvent`} label="Solvent" className="w-40">
                  {(field) => (
                    <Input {...field} value={control.solvent} onChange={(event) => controls.update(index, { solvent: event.target.value })} />
                  )}
                </Field>
                <Field path={`${path}.solvent_percentage`} label="Solvent, final" className="w-32">
                  {(field) => (
                    <UnitInput
                      {...field}
                      unit="%"
                      value={control.solvent_percentage}
                      onChange={(event) => controls.update(index, { solvent_percentage: event.target.value })}
                    />
                  )}
                </Field>
              </>
            )}
            {type === "minus_cofactor" ? (
              <Field path={`${path}.omitted_cofactor`} label="Leaves out" className="w-44">
                {(field) => (
                  <Select {...field} value={control.omitted_cofactor} onChange={(event) => controls.update(index, { omitted_cofactor: event.target.value })}>
                    {control.omitted_cofactor !== EVERY_COFACTOR && !cofactors.some((row) => String(row.key) === control.omitted_cofactor) ? (
                      <option value={control.omitted_cofactor} disabled>
                        Choose a cofactor
                      </option>
                    ) : null}
                    <option value={EVERY_COFACTOR}>Every cofactor</option>
                    {cofactors.map((cofactor) => (
                      <option key={cofactor.key} value={String(cofactor.key)}>
                        {cofactor.cofactor.trim()}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            {ownProtein && (type === "heat_inactivated" || type === "other") ? (
              <Field path={`${path}.protein_concentration`} label="Protein override" className="w-36">
                {(field) => (
                  <UnitInput
                    {...field}
                    unit="mg/mL"
                    value={control.protein_concentration}
                    onChange={(event) => controls.update(index, { protein_concentration: event.target.value })}
                  />
                )}
              </Field>
            ) : null}
            <Field path={`${path}.incubation_minutes`} label="Time in its stage" className="w-36">
              {(field) => (
                <UnitInput
                  {...field}
                  unit="min"
                  placeholder={stageMinutes}
                  value={control.incubation_minutes}
                  onChange={(event) => controls.update(index, { incubation_minutes: event.target.value })}
                />
              )}
            </Field>
            {draft.sampling === "endpoint" ? (
              <Field path={`${path}.replicates`} label="Replicates" required className="w-28">
                {(field) => (
                  <Input
                    {...field}
                    inputMode="numeric"
                    value={control.replicates}
                    onChange={(event) => controls.update(index, { replicates: event.target.value })}
                    className="tabular-nums"
                  />
                )}
              </Field>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${name}`}
              className="mt-6 text-ink-2"
            >
              <X aria-hidden />
              Remove
            </Button>
          </fieldset>
        );
      })}
      <AddRowButton
        path={addPath}
        full={draft.controls.length >= MAX_ROWS.controls}
        onClick={() => controls.add(blankControl(stage))}
      >
        Add control
      </AddRowButton>
    </div>
  );
}
