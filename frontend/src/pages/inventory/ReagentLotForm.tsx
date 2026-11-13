import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Plus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Schemas } from "@/api/client";
import { invalidateLots, mutations, queries } from "@/api/queries";
import { NotFound } from "@/components/AppShell";
import { LotFlagBadges } from "@/components/badges";
import { ComponentList } from "@/components/ComponentList";
import {
  AddRowButton,
  Field,
  fieldId,
  FieldProblems,
  FormSection,
  Input,
  LeaveWarning,
  listEditor,
  NumberWithUnit,
  ProblemAlert,
  RepeatGroup,
  RequiredNote,
  Select,
  UnitInput,
  useFocusAfterRender,
  useFormProblems,
  useLeaveGuard,
} from "@/components/form";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AMOUNT_UNITS, COMPONENT_UNITS, LOT_CONCENTRATION_UNITS, unitChoices } from "@/lib/domain";
import { withFlash } from "@/lib/flash";
import * as format from "@/lib/format";
import { parseId } from "@/lib/params";
import {
  blankComponent,
  blankLot,
  componentsFrom,
  draftFromRow,
  existingReagent,
  lotChanges,
  newLotBody,
  type EditLotDraft,
  type LotDraft,
  type NewLotDraft,
} from "./lot-draft";

const LIST = "/inventory/reagents";

function LotPageHeader({ current, title, children }: { current: string; title: string; children?: ReactNode }) {
  return (
    <header>
      <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
        <Link to={LIST} className="font-bold text-ballpoint underline-offset-2 hover:underline">
          Reagent lots
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <span aria-current="page">{current}</span>
      </nav>
      <h1 className="mt-3 text-[1.75rem] leading-tight font-bold">{title}</h1>
      {children}
    </header>
  );
}

export function NewReagentLotPage() {
  const reference = useQuery(queries.reference());
  return (
    <div className="max-w-5xl space-y-6">
      <LotPageHeader current="Add lot" title="Add a reagent lot" />
      {reference.isPending ? (
        <Loading label="Loading reagents…" />
      ) : reference.isError ? (
        <ErrorState title="The reagent list could not load" error={reference.error} onRetry={() => reference.refetch()} />
      ) : (
        <NewLotForm
          reagents={reference.data.reagents}
          compounds={reference.data.compounds}
          reagentTypes={reference.data.reagent_types}
          lots={reference.data.reagent_lots}
        />
      )}
    </div>
  );
}

function NewLotForm({
  reagents,
  compounds,
  reagentTypes,
  lots,
}: {
  reagents: Schemas["ReagentRef"][];
  compounds: Schemas["NamedRef"][];
  reagentTypes: Schemas["ReferenceData"]["reagent_types"];
  lots: Schemas["ReagentLotRow"][];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [initial] = useState(blankLot);
  const [draft, setDraft] = useState(initial);
  const problems = useFormProblems();
  const guard = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial));
  const create = useMutation({
    mutationFn: mutations.createReagentLot,
    onSuccess: async (lot) => {
      await invalidateLots(queryClient);
      guard.allowLeave();
      navigate(LIST, { state: withFlash({ kind: "lot-saved", action: "added", lotId: lot.id }) });
    },
    onError: problems.showServerError,
  });

  function set<K extends keyof NewLotDraft>(key: K, value: NewLotDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const focusAfterRender = useFocusAfterRender();
  const componentRows = listEditor({
    path: "components",
    rows: draft.components,
    firstField: "component_name",
    clearUnder: problems.clearUnder,
    focusAfterRender,
    setRows: (update) => setDraft((current) => ({ ...current, components: update(current.components) })),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = newLotBody(draft, reagents);
    if (parsed.ok) create.mutate(parsed.body);
    else problems.showFieldErrors(parsed.errors);
  }

  const name = draft.reagent_name.trim();
  const match = name ? existingReagent(reagents, name) : null;
  const isSystem = match ? match.reagent_type === "regenerating_system" : Boolean(name) && draft.reagent_type === "regenerating_system";
  // The most recently added lot of this system that lists components.
  const earlier = match
    ? lots.filter((lot) => lot.reagent === match.name && lot.components.length > 0).sort((a, b) => b.id - a.id)[0]
    : undefined;

  return (
    <FieldProblems errors={problems.fields} clear={problems.clear}>
      <form ref={problems.formRef} onSubmit={submit} noValidate className="space-y-6">
        <LeaveWarning blocker={guard.blocker} what="The new lot" />
        <ProblemAlert title="The lot was not added" message={problems.general} alertRef={problems.alertRef} />
        <RequiredNote />

        <FormSection title="Reagent" description="Type a reagent the lab already stocks, or a new one.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              path="reagent_name"
              label="Reagent"
              required
              hint={
                match ? (
                  <span className="inline-flex items-center gap-1">
                    <CircleCheck aria-hidden className="size-3.5 text-good-fg" />
                    Adds a lot of {match.name}
                    {match.reagent_type ? `, ${format.humanize(match.reagent_type).toLowerCase()}` : ""}.
                  </span>
                ) : name ? (
                  "A new reagent. Describe it below."
                ) : (
                  "Suggestions come from the reagents already in the inventory."
                )
              }
            >
              {(control) => (
                <Input
                  {...control}
                  list="reagent-names"
                  value={draft.reagent_name}
                  onChange={(event) => set("reagent_name", event.target.value)}
                />
              )}
            </Field>
            <datalist id="reagent-names">
              {reagents.map((reagent) => (
                <option key={reagent.id} value={reagent.name} />
              ))}
            </datalist>
          </div>
          {name && !match ? (
            <div className="grid gap-4 border-l-2 border-rule-strong pl-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field path="reagent_type" label="Reagent type">
                {(control) => (
                  <Select
                    {...control}
                    value={draft.reagent_type}
                    onChange={(event) => set("reagent_type", reagentTypes.find((type) => type === event.target.value) ?? "")}
                  >
                    <option value="">Not set</option>
                    {reagentTypes.map((type) => (
                      <option key={type} value={type}>
                        {format.humanize(type)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field path="compound_name" label="Compound" hint="The active compound, if any.">
                {(control) => (
                  <Input
                    {...control}
                    list="compound-names"
                    value={draft.compound_name}
                    onChange={(event) => set("compound_name", event.target.value)}
                  />
                )}
              </Field>
              <datalist id="compound-names">
                {compounds.map((compound) => (
                  <option key={compound.id} value={compound.name} />
                ))}
              </datalist>
            </div>
          ) : null}
          {isSystem ? (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-ink-2">Components</h3>
              <p className="max-w-[72ch] text-sm text-ink-3">
                What this lot holds, such as NADP+ and glucose-6-phosphate in Solution A, and the lots it was made from.
              </p>
              {earlier && draft.components.length === 0 ? (
                <Button type="button" variant="outline" onClick={() => set("components", componentsFrom(earlier))}>
                  Start from lot {earlier.lot_number}'s components
                </Button>
              ) : null}
              {draft.components.map((row, index) => (
                <RepeatGroup
                  key={row.key}
                  title={`Component ${index + 1}${row.component_name.trim() ? `, ${row.component_name.trim()}` : ""}`}
                  removeLabel={`Remove component ${index + 1}`}
                  onRemove={() => componentRows.remove(index)}
                >
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_14rem_minmax(0,1.5fr)]">
                    <Field path={`components.${index}.component_name`} label="Component" required>
                      {(control) => (
                        <Input
                          {...control}
                          value={row.component_name}
                          onChange={(event) => componentRows.update(index, { component_name: event.target.value })}
                        />
                      )}
                    </Field>
                    <Field path={`components.${index}.amount`} label="Amount">
                      {(control) => (
                        <NumberWithUnit
                          {...control}
                          value={row.amount}
                          onChange={(event) => componentRows.update(index, { amount: event.target.value })}
                          unitLabel={`Component ${index + 1} unit`}
                          unitValue={row.amount_unit}
                          units={unitChoices(COMPONENT_UNITS, row.amount_unit)}
                          onUnitChange={(unit) => componentRows.update(index, { amount_unit: unit })}
                        />
                      )}
                    </Field>
                    <Field path={`components.${index}.component_lot_id`} label="Its lot" hint="The lot it was made from, if it is in the inventory.">
                      {(control) => (
                        <Select
                          {...control}
                          value={row.component_lot_id}
                          onChange={(event) => componentRows.update(index, { component_lot_id: event.target.value })}
                        >
                          <option value="">No lot</option>
                          {lots.map((lot) => (
                            <option key={lot.id} value={lot.id}>
                              {lot.lot_number}, {lot.reagent}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                </RepeatGroup>
              ))}
              <AddRowButton path="components" full={draft.components.length >= 12} onClick={() => componentRows.add(blankComponent())}>
                Add component
              </AddRowButton>
            </div>
          ) : null}
        </FormSection>

        <FormSection title="Lot">
          <LotFields draft={draft} onChange={(key, value) => set(key, value)} remainingHint="Leave empty if unopened." />
        </FormSection>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={create.isPending} className="px-4 font-bold">
            <Plus aria-hidden />
            {create.isPending ? "Adding…" : "Add lot"}
          </Button>
          <Button asChild variant="outline" size="lg" className="px-4">
            <Link to={LIST}>Cancel</Link>
          </Button>
        </div>
      </form>
    </FieldProblems>
  );
}

/** The lot's own fields, the same when adding a lot and when editing one. */
function LotFields({
  draft,
  onChange,
  remainingHint,
  children,
}: {
  draft: LotDraft;
  onChange: (key: keyof LotDraft, value: string) => void;
  remainingHint?: string;
  children?: ReactNode;
}) {
  const amountUnit = format.unit(draft.quantity_unit);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field path="lot_number" label="Lot number" required>
          {(control) => (
            <Input
              {...control}
              value={draft.lot_number}
              onChange={(event) => onChange("lot_number", event.target.value)}
              className="font-bold tracking-wide"
            />
          )}
        </Field>
        <Field path="vendor" label="Manufacturer or vendor">
          {(control) => <Input {...control} value={draft.vendor} onChange={(event) => onChange("vendor", event.target.value)} />}
        </Field>
        <Field path="catalog_number" label="Catalog number" hint="Lots of one reagent can carry different catalog numbers.">
          {(control) => (
            <Input {...control} value={draft.catalog_number} onChange={(event) => onChange("catalog_number", event.target.value)} />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field path="concentration" label="Concentration">
          {(control) => (
            <NumberWithUnit
              {...control}
              value={draft.concentration}
              onChange={(event) => onChange("concentration", event.target.value)}
              unitValue={draft.concentration_unit}
              units={unitChoices(LOT_CONCENTRATION_UNITS, draft.concentration_unit)}
              onUnitChange={(value) => onChange("concentration_unit", value)}
              unitLabel="Concentration unit"
            />
          )}
        </Field>
        <Field path="received_date" label="Received">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.received_date}
              onChange={(event) => onChange("received_date", event.target.value)}
            />
          )}
        </Field>
        <Field path="expiry_date" label="Expiry">
          {(control) => (
            <Input {...control} type="date" value={draft.expiry_date} onChange={(event) => onChange("expiry_date", event.target.value)} />
          )}
        </Field>
        <Field path="storage_temp_c" label="Storage" hint="−80, −20, 4 or room temperature.">
          {(control) => (
            <UnitInput
              {...control}
              unit="°C"
              value={draft.storage_temp_c}
              onChange={(event) => onChange("storage_temp_c", event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field path="quantity_received" label="Amount received">
          {(control) => (
            <NumberWithUnit
              {...control}
              value={draft.quantity_received}
              onChange={(event) => onChange("quantity_received", event.target.value)}
              unitValue={draft.quantity_unit}
              units={unitChoices(AMOUNT_UNITS, draft.quantity_unit)}
              onUnitChange={(value) => onChange("quantity_unit", value)}
              unitLabel="Amount unit"
            />
          )}
        </Field>
        <Field path="quantity_remaining" label="Amount remaining" hint={remainingHint}>
          {(control) => (
            <UnitInput
              {...control}
              unit={amountUnit}
              value={draft.quantity_remaining}
              onChange={(event) => onChange("quantity_remaining", event.target.value)}
            />
          )}
        </Field>
        {children}
      </div>
      <Field path="notes" label="Notes">
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={draft.notes}
            onChange={(event) => onChange("notes", event.target.value)}
            className="text-[0.9375rem] md:text-[0.9375rem]"
          />
        )}
      </Field>
    </>
  );
}

export function EditReagentLotPage() {
  const lotId = parseId(useParams().lotId);
  const lots = useQuery(queries.reagentLots());
  if (lotId === null) return <NotFound what="reagent lot" />;
  if (lots.isPending) return <Loading label="Loading the lot…" />;
  if (lots.isError) return <ErrorState title="This lot could not load" error={lots.error} onRetry={() => lots.refetch()} />;
  const row = lots.data.find((lot) => lot.id === lotId);
  if (!row) return <NotFound what="reagent lot" />;
  return <EditLotForm key={row.id} row={row} />;
}

function EditLotForm({ row }: { row: Schemas["ReagentLotRow"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const compounds = useQuery(queries.reference()).data?.compounds ?? [];
  const [original] = useState(row);
  const [initial] = useState(() => draftFromRow(original));
  const [draft, setDraft] = useState(initial);
  const problems = useFormProblems();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useLeaveGuard(dirty);
  const update = useMutation({
    mutationFn: (body: Schemas["ReagentLotUpdate"]) => mutations.updateReagentLot(row.id, body),
    onSuccess: async () => {
      await invalidateLots(queryClient);
      guard.allowLeave();
      navigate(LIST, { state: withFlash({ kind: "lot-saved", action: "updated", lotId: row.id }) });
    },
    onError: problems.showServerError,
  });

  function set<K extends keyof EditLotDraft>(key: K, value: EditLotDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = lotChanges(original, draft);
    if (parsed.ok) update.mutate(parsed.body);
    else problems.showFieldErrors(parsed.errors);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <LotPageHeader current={row.lot_number} title={`Edit lot ${row.lot_number}`}>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-ink-2">
            {[row.reagent, row.reagent_type ? format.humanize(row.reagent_type).toLowerCase() : null, row.vendor]
              .filter(Boolean)
              .join(", ")}
          </p>
          <LotFlagBadges lot={row} />
        </div>
      </LotPageHeader>
      <FieldProblems errors={problems.fields} clear={problems.clear}>
        <form ref={problems.formRef} onSubmit={submit} noValidate className="space-y-6">
          <LeaveWarning blocker={guard.blocker} what="Your change to this lot" />
          <ProblemAlert title="The lot was not saved" message={problems.general} alertRef={problems.alertRef} />
          <RequiredNote />
          {row.compound === null ? (
            <FormSection
              title="Reagent"
              description="This lot's reagent names no compound, so an experiment cannot check that it is a lot of the compound it names. Link it here."
            >
              <Field path="compound_name" label="Compound" className="max-w-sm">
                {(control) => (
                  <Input
                    {...control}
                    list="lot-compound-names"
                    value={draft.compound_name}
                    onChange={(event) => set("compound_name", event.target.value)}
                  />
                )}
              </Field>
              <datalist id="lot-compound-names">
                {compounds.map((compound) => (
                  <option key={compound.id} value={compound.name} />
                ))}
              </datalist>
            </FormSection>
          ) : null}
          {row.components.length > 0 ? (
            <FormSection title="Components" description="What this lot of the regenerating system holds, and the lots it was made from.">
              <ComponentList components={row.components} />
            </FormSection>
          ) : null}
          <FormSection title="Lot" description="Only the values you change are saved. Empty a field to clear it.">
            <LotFields draft={draft} onChange={(key, value) => set(key, value)}>
              <div className="flex min-w-0 flex-col gap-1">
                <span aria-hidden className="text-sm font-bold text-ink-2">
                  Stock
                </span>
                <label className="flex h-9 w-fit cursor-pointer items-center gap-2 text-[0.9375rem]">
                  <input
                    id={fieldId("is_depleted")}
                    type="checkbox"
                    checked={draft.is_depleted}
                    onChange={(event) => set("is_depleted", event.target.checked)}
                    aria-describedby="used-up-hint"
                    className="size-4 cursor-pointer accent-ink"
                  />
                  Used up
                </label>
                <p id="used-up-hint" className="text-sm text-ink-3">
                  Shows the lot as depleted, whatever amount is recorded.
                </p>
              </div>
            </LotFields>
          </FormSection>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={!dirty || update.isPending} className="px-4 font-bold">
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button asChild variant="outline" size="lg" className="px-4">
              <Link to={LIST}>Cancel</Link>
            </Button>
            {!dirty ? <p className="text-sm text-ink-3">Change a value to save.</p> : null}
          </div>
        </form>
      </FieldProblems>
    </div>
  );
}

