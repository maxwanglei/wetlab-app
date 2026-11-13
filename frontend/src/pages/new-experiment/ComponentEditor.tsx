import type { Schemas } from "@/api/client";
import { ComponentList } from "@/components/ComponentList";
import { Field, Input, NumberWithUnit, RepeatGroup, Select, type ListEditor } from "@/components/form";
import { COMPONENT_ROLE_LABEL, COMPONENT_ROLES, COMPONENT_UNITS, unitChoices } from "@/lib/domain";
import * as format from "@/lib/format";
import { NEW_SOLUTION, lotsForRole, type CofactorDraft } from "./experiment-draft";
import { LotSelect } from "./LotSelect";

/** One component of the incubation: what it is, what it is for, how much, which lot, and the prepared solution
 * it came from. A regenerating-system lot lists what it holds, since leaving the component out leaves all of
 * that out. */
export function ComponentEditor({
  index,
  row,
  rows,
  lots,
  members,
  solutions,
  onRemove,
}: {
  index: number;
  row: CofactorDraft;
  rows: ListEditor<CofactorDraft>;
  lots: readonly Schemas["ReagentLotRow"][];
  members: readonly Schemas["NamedRef"][];
  solutions: readonly Schemas["PreparedSolutionOut"][];
  onRemove: () => void;
}) {
  const path = `cofactors.${index}`;
  const fitting = lotsForRole(lots, row.role);
  const chosen = lots.find((lot) => String(lot.id) === row.reagent_lot_id);
  const setSolution = (patch: Partial<CofactorDraft["new_solution"]>) =>
    rows.update(index, { new_solution: { ...row.new_solution, ...patch } });

  return (
    <RepeatGroup
      title={`Component ${index + 1}${row.cofactor.trim() ? `, ${row.cofactor.trim()}` : ""}`}
      removeLabel={`Remove component ${index + 1}`}
      onRemove={onRemove}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_11rem_13rem_minmax(0,2fr)]">
        <Field path={`${path}.cofactor`} label="Component" required>
          {(control) => (
            <Input {...control} value={row.cofactor} onChange={(event) => rows.update(index, { cofactor: event.target.value })} />
          )}
        </Field>
        <Field path={`${path}.role`} label="Role" required>
          {(control) => (
            <Select
              {...control}
              value={row.role}
              onChange={(event) => {
                const role = COMPONENT_ROLES.find((option) => option === event.target.value);
                if (!role) return;
                const keepsLot = lotsForRole(lots, role).some((lot) => String(lot.id) === row.reagent_lot_id);
                rows.update(index, { role, reagent_lot_id: keepsLot ? row.reagent_lot_id : "" });
              }}
            >
              <option value="" disabled>
                Choose a role
              </option>
              {COMPONENT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {COMPONENT_ROLE_LABEL[role]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field path={`${path}.concentration`} label="Concentration">
          {(control) => (
            <NumberWithUnit
              {...control}
              value={row.concentration}
              onChange={(event) => rows.update(index, { concentration: event.target.value })}
              unitLabel={`Component ${index + 1} unit`}
              unitValue={row.concentration_unit}
              units={unitChoices(COMPONENT_UNITS, row.concentration_unit)}
              onUnitChange={(value) => {
                const unit = COMPONENT_UNITS.find((option) => option === value);
                if (unit) rows.update(index, { concentration_unit: unit });
              }}
            />
          )}
        </Field>
        <Field
          path={`${path}.reagent_lot_id`}
          label="Lot"
          hint={row.role && fitting.length === 0 ? `No ${COMPONENT_ROLE_LABEL[row.role].toLowerCase()} lots are in the inventory.` : undefined}
        >
          {(control) => (
            <LotSelect
              {...control}
              lots={fitting}
              preferred={row.cofactor}
              value={row.reagent_lot_id}
              onChange={(value) => rows.update(index, { reagent_lot_id: value })}
            />
          )}
        </Field>
      </div>

      {chosen && chosen.components.length > 0 ? (
        <div className="mt-3 rounded-md border border-rule bg-surface px-3 py-2">
          <h4 className="text-sm font-bold text-ink-2">{chosen.reagent} holds</h4>
          <ComponentList components={chosen.components} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]">
        <Field path={`${path}.solution`} label="Prepared solution" hint="The stock it was taken from, so who made it is on record.">
          {(control) => (
            <Select {...control} value={row.solution} onChange={(event) => rows.update(index, { solution: event.target.value })}>
              <option value="">Not recorded</option>
              {solutions.map((solution) => (
                <option key={solution.id} value={String(solution.id)}>
                  {solution.label}
                  {solution.prepared_on ? `, ${format.date(solution.prepared_on)}` : ""}
                  {solution.prepared_by ? `, ${solution.prepared_by}` : ""}
                </option>
              ))}
              <option value={NEW_SOLUTION}>A new solution</option>
            </Select>
          )}
        </Field>
        {row.solution === NEW_SOLUTION ? (
          <>
            <Field path={`${path}.solution.label`} label="Solution label" required>
              {(control) => (
                <Input {...control} value={row.new_solution.label} onChange={(event) => setSolution({ label: event.target.value })} />
              )}
            </Field>
            <Field path={`${path}.solution.prepared_by`} label="Prepared by">
              {(control) => (
                <Select {...control} value={row.new_solution.prepared_by} onChange={(event) => setSolution({ prepared_by: event.target.value })}>
                  <option value="">Not recorded</option>
                  {members.map((member) => (
                    <option key={member.id} value={String(member.id)}>
                      {member.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field path={`${path}.solution.prepared_on`} label="Prepared on">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={row.new_solution.prepared_on}
                  onChange={(event) => setSolution({ prepared_on: event.target.value })}
                />
              )}
            </Field>
            <Field path={`${path}.solution.buffer_composition`} label="Buffer composition" className="sm:col-span-2 lg:col-span-4">
              {(control) => (
                <Input
                  {...control}
                  value={row.new_solution.buffer_composition}
                  placeholder="100 mM potassium phosphate, pH 7.4, 3.3 mM MgCl2"
                  onChange={(event) => setSolution({ buffer_composition: event.target.value })}
                />
              )}
            </Field>
          </>
        ) : null}
      </div>
    </RepeatGroup>
  );
}
