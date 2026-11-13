import type { Schemas } from "@/api/client";
import * as format from "@/lib/format";

/** A regenerating system's components, as listed in the inventory and under an experiment's component. */
export function ComponentList({ components }: { components: readonly Schemas["ReagentComponentOut"][] }) {
  return (
    <ul className="space-y-1 text-[0.9375rem]">
      {components.map((component, index) => (
        <li key={`${index}-${component.component_name}`}>
          <span className="font-bold">{component.component_name}</span>{" "}
          <span className="tabular-nums">{format.quantity(component.amount, component.amount_unit)}</span>
          {component.lot_number ? <span className="text-ink-3">, lot {component.lot_number}</span> : null}
        </li>
      ))}
    </ul>
  );
}
