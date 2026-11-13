import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, type Schemas } from "@/api/client";
import { invalidateLots, mutations, queries } from "@/api/queries";
import { NotFound } from "@/components/AppShell";
import { ErrorState, Loading } from "@/components/states";
import {
  Field,
  FieldProblems,
  FormSection,
  Input,
  LeaveWarning,
  NumberWithUnit,
  ProblemAlert,
  RequiredNote,
  Select,
  UnitInput,
  useFormProblems,
  useLeaveGuard,
} from "@/components/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AMOUNT_UNITS, unitChoices } from "@/lib/domain";
import { withFlash } from "@/lib/flash";
import { parseId } from "@/lib/params";
import { blankTissueLot, newTissueLotBody, tissueStockChanges, tissueStockDraft, type TissueDraft, type TissueStockDraft } from "./tissue-draft";

const LIST = "/inventory/tissue";
const MATERIALS = ["HLM", "S9", "cytosol", "hepatocytes", "intestinal_microsomes", "liver_tissue"] as const;
const MATERIAL_LABELS: Record<(typeof MATERIALS)[number], string> = {
  HLM: "Human liver microsomes (HLM)",
  S9: "S9 fraction",
  cytosol: "Cytosol",
  hepatocytes: "Hepatocytes",
  intestinal_microsomes: "Intestinal microsomes",
  liver_tissue: "Liver tissue",
};

export function NewTissueLotPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [initial] = useState(blankTissueLot);
  const [draft, setDraft] = useState(initial);
  const problems = useFormProblems();
  const guard = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial));
  const create = useMutation({
    mutationFn: mutations.createTissueLot,
    onSuccess: async (lot) => {
      await invalidateLots(queryClient);
      guard.allowLeave();
      navigate(LIST, {
        state: withFlash({ kind: "lot-saved", action: "added", lotId: lot.id }),
      });
    },
    onError: problems.showServerError,
  });

  function set<K extends keyof TissueDraft>(key: K, value: TissueDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = newTissueLotBody(draft);
    if (parsed.ok) create.mutate(parsed.body);
    else problems.showFieldErrors(parsed.errors);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
          <Link to={LIST} className="font-bold text-ballpoint underline-offset-2 hover:underline">
            Tissue lots
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span aria-current="page">Add tissue lot</span>
        </nav>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold">Add a tissue lot</h1>
      </header>
      <FieldProblems errors={problems.fields} clear={problems.clear}>
        <form ref={problems.formRef} onSubmit={submit} noValidate className="space-y-6">
          <LeaveWarning blocker={guard.blocker} what="The new lot" />
          <ProblemAlert title="The lot was not added" message={problems.general} alertRef={problems.alertRef} />
          <RequiredNote />

          <FormSection title="Material">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field path="material_type" label="Material type" required>
                {(control) => (
                  <Select
                    {...control}
                    value={draft.material_type}
                    onChange={(event) => set("material_type", MATERIALS.find((type) => type === event.target.value) ?? draft.material_type)}
                  >
                    {MATERIALS.map((type) => (
                      <option key={type} value={type}>
                        {MATERIAL_LABELS[type]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field path="species" label="Species" required>
                {(control) => <Input {...control} value={draft.species} onChange={(event) => set("species", event.target.value)} />}
              </Field>
              <Field path="pooled_or_individual" label="Pooled or individual">
                {(control) => (
                  <Select
                    {...control}
                    value={draft.pooled_or_individual}
                    onChange={(event) =>
                      set(
                        "pooled_or_individual",
                        event.target.value === "pooled" || event.target.value === "individual" ? event.target.value : "",
                      )
                    }
                  >
                    <option value="">Not recorded</option>
                    <option value="pooled">Pooled</option>
                    <option value="individual">Individual</option>
                  </Select>
                )}
              </Field>
              <Field path="number_of_donors" label="Number of donors">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={draft.number_of_donors}
                    onChange={(event) => set("number_of_donors", event.target.value)}
                  />
                )}
              </Field>
            </div>
          </FormSection>

          <FormSection title="Lot">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field path="lot_number" label="Lot number" required>
                {(control) => (
                  <Input
                    {...control}
                    value={draft.lot_number}
                    onChange={(event) => set("lot_number", event.target.value)}
                    className="font-bold tracking-wide"
                  />
                )}
              </Field>
              <Field path="vendor_or_source" label="Supplier or source">
                {(control) => (
                  <Input {...control} value={draft.vendor_or_source} onChange={(event) => set("vendor_or_source", event.target.value)} />
                )}
              </Field>
              <Field path="catalog_number" label="Catalog number">
                {(control) => (
                  <Input {...control} value={draft.catalog_number} onChange={(event) => set("catalog_number", event.target.value)} />
                )}
              </Field>
              {draft.material_type === "hepatocytes" ? (
                <Field path="viability" label="Viability">
                  {(control) => (
                    <UnitInput {...control} unit="%" value={draft.viability} onChange={(event) => set("viability", event.target.value)} />
                  )}
                </Field>
              ) : (
                <Field path="protein_concentration" label="Protein concentration">
                  {(control) => (
                    <UnitInput
                      {...control}
                      unit="mg/mL"
                      value={draft.protein_concentration}
                      onChange={(event) => set("protein_concentration", event.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field path="received_date" label="Received">
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={draft.received_date}
                    onChange={(event) => set("received_date", event.target.value)}
                  />
                )}
              </Field>
              <Field path="expiry_date" label="Expiry">
                {(control) => (
                  <Input {...control} type="date" value={draft.expiry_date} onChange={(event) => set("expiry_date", event.target.value)} />
                )}
              </Field>
              <Field path="storage_temp_c" label="Storage" hint="−80, −20, 4 or room temperature.">
                {(control) => (
                  <UnitInput
                    {...control}
                    unit="°C"
                    value={draft.storage_temp_c}
                    onChange={(event) => set("storage_temp_c", event.target.value)}
                  />
                )}
              </Field>
              <Field path="quantity_remaining" label="Amount remaining">
                {(control) => (
                  <NumberWithUnit
                    {...control}
                    value={draft.quantity_remaining}
                    onChange={(event) => set("quantity_remaining", event.target.value)}
                    unitValue={draft.quantity_unit}
                    units={unitChoices(AMOUNT_UNITS, draft.quantity_unit)}
                    onUnitChange={(value) => set("quantity_unit", value)}
                    unitLabel="Amount unit"
                  />
                )}
              </Field>
            </div>
            <Field path="notes" label="Notes">
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  value={draft.notes}
                  onChange={(event) => set("notes", event.target.value)}
                  className="text-[0.9375rem] md:text-[0.9375rem]"
                />
              )}
            </Field>
          </FormSection>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={create.isPending} className="px-4 font-bold">
              <Plus aria-hidden />
              {create.isPending ? "Adding…" : "Add tissue lot"}
            </Button>
            <Button asChild variant="outline" size="lg" className="px-4">
              <Link to={LIST}>Cancel</Link>
            </Button>
          </div>
        </form>
      </FieldProblems>
    </div>
  );
}

export function EditTissueLotPage() {
  const lotId = parseId(useParams().lotId);
  const lot = useQuery({ ...queries.tissueLot(lotId ?? 0), enabled: lotId !== null });
  if (lotId === null) return <NotFound what="tissue lot" />;
  if (lot.isPending) return <Loading label="Loading the tissue lot…" />;
  if (lot.isError) {
    if (lot.error instanceof ApiError && lot.error.status === 404) return <NotFound what="tissue lot" />;
    return <ErrorState title="This tissue lot could not load" error={lot.error} onRetry={() => lot.refetch()} />;
  }
  return <TissueStockForm key={lot.data.id} row={lot.data} />;
}

function TissueStockForm({ row }: { row: Schemas["TissueLotRow"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [original] = useState(row);
  const [initial] = useState(() => tissueStockDraft(original));
  const [draft, setDraft] = useState(initial);
  const problems = useFormProblems();
  const guard = useLeaveGuard(JSON.stringify(draft) !== JSON.stringify(initial));
  const update = useMutation({
    mutationFn: (body: Schemas["TissueLotUpdate"]) => mutations.updateTissueLot(row.id, body),
    onSuccess: async () => {
      await invalidateLots(queryClient);
      guard.allowLeave();
      navigate(LIST, { state: withFlash({ kind: "lot-saved", action: "updated", lotId: row.id }) });
    },
    onError: problems.showServerError,
  });

  function set<K extends keyof TissueStockDraft>(key: K, value: TissueStockDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = tissueStockChanges(original, draft);
    if (parsed.ok) update.mutate(parsed.body);
    else problems.showFieldErrors(parsed.errors);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
          <Link to={LIST} className="font-bold text-ballpoint underline-offset-2 hover:underline">Tissue lots</Link>
          <span aria-hidden className="mx-1.5">/</span>
          <Link to={`/inventory/tissue-lots/${row.id}`} className="font-bold text-ballpoint underline-offset-2 hover:underline">
            {row.lot_number ?? `Lot ${row.id}`}
          </Link>
          <span aria-hidden className="mx-1.5">/</span>
          <span aria-current="page">Update stock</span>
        </nav>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold">Update tissue stock</h1>
      </header>
      <FieldProblems errors={problems.fields} clear={problems.clear}>
        <form ref={problems.formRef} onSubmit={submit} noValidate className="space-y-6">
          <LeaveWarning blocker={guard.blocker} what="The stock changes" />
          <ProblemAlert title="The tissue lot was not updated" message={problems.general} alertRef={problems.alertRef} />
          <FormSection title="Stock">
            <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field path="quantity_remaining" label="Amount remaining" hint="Zero remaining is flagged as depleted.">
                {(control) => (
                  <NumberWithUnit
                    {...control}
                    value={draft.quantity_remaining}
                    onChange={(event) => set("quantity_remaining", event.target.value)}
                    unitValue={draft.quantity_unit}
                    units={unitChoices(AMOUNT_UNITS, draft.quantity_unit)}
                    onUnitChange={(value) => set("quantity_unit", value)}
                    unitLabel="Amount unit"
                  />
                )}
              </Field>
              <Field path="is_depleted" label="Used up" hint="Mark this when the lot is no longer available.">
                {(control) => (
                  <input {...control} type="checkbox" checked={draft.is_depleted} onChange={(event) => set("is_depleted", event.target.checked)} className="size-5" />
                )}
              </Field>
            </div>
          </FormSection>
          <FormSection title="Lot and storage">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field path="catalog_number" label="Catalog number">
                {(control) => <Input {...control} value={draft.catalog_number} onChange={(event) => set("catalog_number", event.target.value)} />}
              </Field>
              <Field path="expiry_date" label="Expiry">
                {(control) => <Input {...control} type="date" value={draft.expiry_date} onChange={(event) => set("expiry_date", event.target.value)} />}
              </Field>
              <Field path="storage_temp_c" label="Storage">
                {(control) => <UnitInput {...control} unit="°C" value={draft.storage_temp_c} onChange={(event) => set("storage_temp_c", event.target.value)} />}
              </Field>
            </div>
            <Field path="notes" label="Notes">
              {(control) => <Textarea {...control} rows={3} value={draft.notes} onChange={(event) => set("notes", event.target.value)} />}
            </Field>
          </FormSection>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={update.isPending} className="px-4 font-bold">
              <Save aria-hidden />
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button asChild variant="outline" size="lg"><Link to={`/inventory/tissue-lots/${row.id}`}>Cancel</Link></Button>
          </div>
        </form>
      </FieldProblems>
    </div>
  );
}
