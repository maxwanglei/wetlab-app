import type { Schemas } from "@/api/client";
import { draftReader, numberText, today, type Parsed } from "@/lib/drafts";

type TissueLotIn = Schemas["TissueLotIn"];

export type TissueDraft = {
  material_type: TissueLotIn["material_type"];
  species: string;
  pooled_or_individual: "pooled" | "individual" | "";
  number_of_donors: string;
  vendor_or_source: string;
  catalog_number: string;
  lot_number: string;
  protein_concentration: string;
  viability: string;
  received_date: string;
  expiry_date: string;
  storage_temp_c: string;
  quantity_remaining: string;
  quantity_unit: string;
  notes: string;
};

export function blankTissueLot(): TissueDraft {
  return {
    material_type: "HLM",
    species: "human",
    pooled_or_individual: "",
    number_of_donors: "",
    vendor_or_source: "",
    catalog_number: "",
    lot_number: "",
    protein_concentration: "",
    viability: "",
    received_date: today(),
    expiry_date: "",
    storage_temp_c: "",
    quantity_remaining: "",
    quantity_unit: "uL",
    notes: "",
  };
}

export function newTissueLotBody(draft: TissueDraft): Parsed<TissueLotIn> {
  const read = draftReader();
  const donors = read.number("number_of_donors", draft.number_of_donors);
  if (donors !== null && (!Number.isInteger(donors) || donors < 1)) {
    read.fail("number_of_donors", "Enter a whole number, 1 or more.");
  } else if (donors !== null && donors > 1 && draft.pooled_or_individual === "individual") {
    read.fail("number_of_donors", "An individual lot comes from one donor.");
  }
  const viability = draft.material_type === "hepatocytes" ? read.number("viability", draft.viability) : null;
  if (viability !== null && (viability < 0 || viability > 100)) read.fail("viability", "Enter a percentage from 0 to 100.");
  if (draft.received_date && draft.expiry_date && draft.expiry_date < draft.received_date) {
    read.fail("expiry_date", "Is before the received date.");
  }
  const remaining = read.number("quantity_remaining", draft.quantity_remaining);
  return read.result({
    material_type: draft.material_type,
    species: read.text("species", draft.species, { required: true }) ?? "",
    pooled_or_individual: draft.pooled_or_individual || null,
    number_of_donors: donors,
    vendor_or_source: read.text("vendor_or_source", draft.vendor_or_source),
    catalog_number: read.text("catalog_number", draft.catalog_number),
    lot_number: read.text("lot_number", draft.lot_number, { required: true }) ?? "",
    protein_concentration: read.number("protein_concentration", draft.protein_concentration),
    viability,
    received_date: draft.received_date || null,
    expiry_date: draft.expiry_date || null,
    storage_temp_c: read.number("storage_temp_c", draft.storage_temp_c),
    quantity_remaining: remaining,
    quantity_unit: remaining === null ? null : draft.quantity_unit,
    notes: read.text("notes", draft.notes),
  });
}

export type TissueStockDraft = {
  catalog_number: string;
  expiry_date: string;
  storage_temp_c: string;
  quantity_remaining: string;
  quantity_unit: string;
  is_depleted: boolean;
  notes: string;
};

export function tissueStockDraft(row: Schemas["TissueLotRow"]): TissueStockDraft {
  return {
    catalog_number: row.catalog_number ?? "",
    expiry_date: row.expiry_date ?? "",
    storage_temp_c: numberText(row.storage_temp_c),
    quantity_remaining: numberText(row.quantity_remaining),
    quantity_unit: row.quantity_unit ?? "uL",
    is_depleted: row.is_depleted,
    notes: row.notes ?? "",
  };
}

export function tissueStockChanges(row: Schemas["TissueLotRow"], draft: TissueStockDraft): Parsed<Schemas["TissueLotUpdate"]> {
  const read = draftReader();
  const remaining = read.number("quantity_remaining", draft.quantity_remaining);
  if (remaining !== null && remaining < 0) read.fail("quantity_remaining", "Enter zero or more.");
  if (row.received_date && draft.expiry_date && draft.expiry_date < row.received_date) {
    read.fail("expiry_date", "Is before the received date.");
  }
  const values = {
    catalog_number: read.text("catalog_number", draft.catalog_number),
    expiry_date: draft.expiry_date || null,
    storage_temp_c: read.number("storage_temp_c", draft.storage_temp_c),
    quantity_remaining: remaining,
    quantity_unit: remaining === null ? null : draft.quantity_unit,
    is_depleted: draft.is_depleted,
    notes: read.text("notes", draft.notes),
  };
  const changed = <T,>(value: T, original: T): T | undefined => (value === original ? undefined : value);
  return read.result({
    catalog_number: changed(values.catalog_number, row.catalog_number),
    expiry_date: changed(values.expiry_date, row.expiry_date),
    storage_temp_c: changed(values.storage_temp_c, row.storage_temp_c),
    quantity_remaining: changed(values.quantity_remaining, row.quantity_remaining),
    quantity_unit: changed(values.quantity_unit, row.quantity_unit),
    is_depleted: changed(values.is_depleted, row.is_depleted),
    notes: changed(values.notes, row.notes),
  });
}
