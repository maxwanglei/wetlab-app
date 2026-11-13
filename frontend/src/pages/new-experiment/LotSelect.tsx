import type { ComponentProps } from "react";
import type { Schemas } from "@/api/client";
import { Select } from "@/components/form";
import { LOT_FLAG } from "@/lib/domain";
import * as format from "@/lib/format";
import { isLotOf } from "./experiment-draft";

type Lot = Schemas["ReagentLotRow"];

function lotLabel(lot: Lot): string {
  const details = [
    lot.reagent,
    format.quantity(lot.concentration, lot.concentration_unit),
    ...lot.flags.map((flag) => LOT_FLAG[flag].label(lot).toLowerCase()),
  ].filter(Boolean);
  return `${lot.lot_number}, ${details.join(", ")}`;
}

/** A choice of reagent lot; lots of the `preferred` compound, when any, come first in their own group. */
export function LotSelect({
  lots,
  preferred = "",
  value,
  onChange,
  ...control
}: {
  lots: readonly Lot[];
  preferred?: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<ComponentProps<"select">, "value" | "onChange">) {
  const name = preferred.trim();
  const matching = name ? lots.filter((lot) => isLotOf(lot, name)) : [];
  const others = lots.filter((lot) => !matching.includes(lot));
  const options = (group: readonly Lot[]) =>
    group.map((lot) => (
      <option key={lot.id} value={lot.id}>
        {lotLabel(lot)}
      </option>
    ));
  return (
    <Select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">No lot</option>
      {matching.length > 0 ? (
        <>
          <optgroup label={`Lots of ${name}`}>{options(matching)}</optgroup>
          {others.length > 0 ? <optgroup label="Other lots">{options(others)}</optgroup> : null}
        </>
      ) : (
        options(others)
      )}
    </Select>
  );
}
