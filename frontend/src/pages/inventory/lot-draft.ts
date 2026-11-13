import type { Schemas } from "@/api/client";
import type { ReagentType } from "@/lib/domain";
import { draftReader, numberText, sameName, today, type Parsed } from "@/lib/drafts";

type LotRow = Schemas["ReagentLotRow"];

/** The lot's own fields as typed, keyed like the request body. */
export type LotDraft = {
  lot_number: string;
  vendor: string;
  catalog_number: string;
  concentration: string;
  concentration_unit: string;
  received_date: string;
  expiry_date: string;
  storage_temp_c: string;
  quantity_received: string;
  quantity_remaining: string;
  quantity_unit: string;
  notes: string;
};

/** One thing a regenerating system holds, such as NADP+ in Solution A. */
export type ComponentDraft = { key: number; component_name: string; amount: string; amount_unit: string; component_lot_id: string };

/** Type and compound describe the reagent, so they are asked for only when the typed reagent name is not one
 * the lab already has. Vendor and catalog number belong to each lot, since two lots of one reagent can differ.
 * A lot of a regenerating system also lists its components and the lots they were made from. */
export type NewLotDraft = LotDraft & {
  reagent_name: string;
  reagent_type: ReagentType | "";
  compound_name: string;
  components: ComponentDraft[];
};

let lastComponentKey = 0;
export function blankComponent(): ComponentDraft {
  lastComponentKey += 1;
  return { key: lastComponentKey, component_name: "", amount: "", amount_unit: "mM", component_lot_id: "" };
}

/** A new batch starts from an earlier lot's components; the lots they were made from are chosen again. */
export function componentsFrom(lot: LotRow): ComponentDraft[] {
  return lot.components.map((component) => ({
    ...blankComponent(),
    component_name: component.component_name,
    amount: numberText(component.amount),
    amount_unit: component.amount_unit ?? "mM",
  }));
}

/** `compound_name` links the lot's reagent to its compound, offered only while the reagent names none. */
export type EditLotDraft = LotDraft & { is_depleted: boolean; compound_name: string };

export function blankLot(): NewLotDraft {
  return {
    reagent_name: "",
    reagent_type: "",
    compound_name: "",
    vendor: "",
    catalog_number: "",
    lot_number: "",
    concentration: "",
    concentration_unit: "mM",
    received_date: today(),
    expiry_date: "",
    storage_temp_c: "",
    quantity_received: "",
    quantity_remaining: "",
    quantity_unit: "mL",
    notes: "",
    components: [],
  };
}

export function draftFromRow(row: LotRow): EditLotDraft {
  return {
    lot_number: row.lot_number,
    vendor: row.vendor ?? "",
    catalog_number: row.catalog_number ?? "",
    concentration: numberText(row.concentration),
    concentration_unit: row.concentration_unit ?? "mM",
    received_date: row.received_date ?? "",
    expiry_date: row.expiry_date ?? "",
    storage_temp_c: numberText(row.storage_temp_c),
    quantity_received: numberText(row.quantity_received),
    quantity_remaining: numberText(row.quantity_remaining),
    quantity_unit: row.quantity_unit ?? "mL",
    notes: row.notes ?? "",
    is_depleted: row.is_depleted,
    compound_name: "",
  };
}

export function existingReagent(reagents: readonly Schemas["ReagentRef"][], name: string) {
  return reagents.find((reagent) => sameName(reagent.name, name)) ?? null;
}

/** An empty amount remaining on a new lot means unopened: all of it is left. */
function readLot(read: ReturnType<typeof draftReader>, draft: LotDraft, { unopenedIfBlank }: { unopenedIfBlank: boolean }) {
  const concentration = read.number("concentration", draft.concentration);
  const received = read.number("quantity_received", draft.quantity_received);
  const typedRemaining = read.number("quantity_remaining", draft.quantity_remaining);
  const remaining = typedRemaining ?? (unopenedIfBlank ? received : null);
  if (received !== null && remaining !== null && remaining > received) {
    read.fail("quantity_remaining", "Can't be more than the amount received.");
  }
  if (draft.received_date && draft.expiry_date && draft.expiry_date < draft.received_date) {
    read.fail("expiry_date", "Is before the received date.");
  }
  return {
    lot_number: read.text("lot_number", draft.lot_number, { required: true }) ?? "",
    vendor: read.text("vendor", draft.vendor),
    catalog_number: read.text("catalog_number", draft.catalog_number),
    concentration,
    concentration_unit: concentration === null ? null : draft.concentration_unit,
    received_date: draft.received_date || null,
    expiry_date: draft.expiry_date || null,
    storage_temp_c: read.number("storage_temp_c", draft.storage_temp_c),
    quantity_received: received,
    quantity_remaining: remaining,
    quantity_unit: received === null && remaining === null ? null : draft.quantity_unit,
    notes: read.text("notes", draft.notes),
  };
}

export function newLotBody(draft: NewLotDraft, reagents: readonly Schemas["ReagentRef"][]): Parsed<Schemas["ReagentLotIn"]> {
  const read = draftReader();
  const reagentName = read.text("reagent_name", draft.reagent_name, { required: true });
  const lot = readLot(read, draft, { unopenedIfBlank: true });
  const isNew = reagentName !== null && existingReagent(reagents, reagentName) === null;
  const existing = reagentName ? existingReagent(reagents, reagentName) : null;
  const isSystem = isNew ? draft.reagent_type === "regenerating_system" : existing?.reagent_type === "regenerating_system";
  const components =
    isSystem
      ? draft.components.map((row, index) => {
          const amount = read.number(`components.${index}.amount`, row.amount);
          return {
            component_name: read.text(`components.${index}.component_name`, row.component_name, { required: true }) ?? "",
            amount,
            amount_unit: amount === null ? null : row.amount_unit,
            component_lot_id: read.id(row.component_lot_id),
          };
        })
      : [];
  return read.result({
    reagent_name: reagentName ?? "",
    ...lot,
    ...(isNew
      ? {
          reagent_type: draft.reagent_type || null,
          compound_name: read.text("compound_name", draft.compound_name),
        }
      : {}),
    components,
  });
}

function changed<T>(next: T, saved: T): T | undefined {
  return next === saved ? undefined : next;
}

/** Only the fields that differ from the saved lot; a field emptied in the form is sent as null to clear
 * it. Unchanged fields stay undefined, which the JSON body leaves out. */
export function lotChanges(row: LotRow, draft: EditLotDraft): Parsed<Schemas["ReagentLotUpdate"]> {
  const read = draftReader();
  const next = readLot(read, draft, { unopenedIfBlank: false });
  return read.result({
    lot_number: changed(next.lot_number, row.lot_number),
    vendor: changed(next.vendor, row.vendor),
    catalog_number: changed(next.catalog_number, row.catalog_number),
    concentration: changed(next.concentration, row.concentration),
    concentration_unit: changed(next.concentration_unit, row.concentration_unit),
    received_date: changed(next.received_date, row.received_date),
    expiry_date: changed(next.expiry_date, row.expiry_date),
    storage_temp_c: changed(next.storage_temp_c, row.storage_temp_c),
    quantity_received: changed(next.quantity_received, row.quantity_received),
    quantity_remaining: changed(next.quantity_remaining, row.quantity_remaining),
    quantity_unit: changed(next.quantity_unit, row.quantity_unit),
    is_depleted: changed(draft.is_depleted, row.is_depleted),
    compound_name: row.compound === null ? (read.text("compound_name", draft.compound_name) ?? undefined) : undefined,
    notes: changed(next.notes, row.notes),
  });
}
