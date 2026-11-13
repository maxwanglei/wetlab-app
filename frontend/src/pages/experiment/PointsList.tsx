import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Schemas } from "@/api/client";
import { ArmSwatch } from "@/components/ArmSwatch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EXCLUSION_REASONS, parseReason, reasonLabel, type ArmStyle, type ExclusionReason } from "@/lib/domain";
import type { ExclusionDraft } from "@/lib/exclusions";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";
import { describePoint, type PointRef } from "./DepletionChart";

export function PointsList({
  arms,
  draft,
  styles,
  onExcludedChange,
  onReasonChange,
}: {
  arms: Schemas["ArmResult"][];
  draft: ExclusionDraft;
  styles: ReadonlyMap<string, ArmStyle>;
  onExcludedChange: (ref: PointRef, excluded: boolean) => void;
  onReasonChange: (ref: PointRef, reason: ExclusionReason) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = arms.reduce((sum, arm) => sum + arm.points.length, 0);
  const missingReasons = [...draft.values()].filter((reason) => reason === null).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-rule">
      <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2.5 text-left hover:bg-paper/60 focus-visible:outline-2 focus-visible:outline-ballpoint">
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="font-bold">Points</span>
        <span className="text-sm text-ink-2">
          {format.count(total, "measurement")}, {draft.size} excluded
          {missingReasons > 0 ? (
            <span className="ml-2 font-bold text-warning-fg">
              {format.count(missingReasons, "exclusion")} still {missingReasons === 1 ? "needs" : "need"} a reason
            </span>
          ) : null}
        </span>
        <span className="ml-auto text-sm text-ink-3">{open ? "Hide" : "Show"} the list to exclude points by keyboard</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-x-6 gap-y-5 border-t border-rule px-3 pt-4 pb-4 lg:grid-cols-2">
          {arms.map((arm) => {
            const style = styles.get(arm.key);
            const points = [...arm.points].sort((a, b) => a.timepoint - b.timepoint || a.replicate - b.replicate);
            return (
              <table key={arm.key} className="w-full text-[0.9375rem] tabular-nums">
                <caption className="mb-1 text-left font-bold">
                  <span className="flex items-center gap-2">
                    {style ? <ArmSwatch style={style} /> : null}
                    {arm.label}
                  </span>
                </caption>
                <thead>
                  <tr className="border-b border-rule-strong text-[0.8125rem] text-ink-2">
                    <th scope="col" className="py-1.5 pr-3 text-right font-bold">
                      Time (min)
                    </th>
                    <th scope="col" className="py-1.5 pr-3 text-left font-bold">
                      Replicate
                    </th>
                    <th scope="col" className="py-1.5 pr-3 text-right font-bold">
                      % of T0
                    </th>
                    <th scope="col" className="py-1.5 pr-3 text-center font-bold">
                      Exclude
                    </th>
                    <th scope="col" className="py-1.5 text-left font-bold">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => {
                    const ref = { arm, point };
                    const description = describePoint(ref);
                    const excluded = draft.has(point.measurement_id);
                    const reason = draft.get(point.measurement_id) ?? null;
                    return (
                      <tr
                        key={point.measurement_id}
                        data-testid={`point-${point.measurement_id}`}
                        className={cn("border-b border-rule last:border-b-0", excluded && "bg-paper")}
                      >
                        <td className="py-1 pr-3 text-right">{format.plain(point.timepoint)}</td>
                        <td className="py-1 pr-3">R{point.replicate}</td>
                        <td className={cn("py-1 pr-3 text-right", excluded && "text-ink-3 line-through")}>
                          {format.fixed(point.percent_of_t0, 2)}
                        </td>
                        <td className="py-1 pr-3 text-center">
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={(event) => onExcludedChange(ref, event.target.checked)}
                            aria-label={`Exclude ${description}`}
                            className="size-4 cursor-pointer align-middle accent-ink"
                          />
                        </td>
                        <td className="py-1">
                          <select
                            value={reason ?? ""}
                            onChange={(event) => {
                              const chosen = parseReason(event.target.value);
                              if (chosen) onReasonChange(ref, chosen);
                            }}
                            aria-label={`Reason for excluding ${description}`}
                            aria-invalid={excluded && reason === null}
                            className={cn(
                              "h-8 w-full max-w-48 rounded-md border bg-surface px-2 text-sm",
                              excluded && reason === null
                                ? "border-warning-fg bg-warning-bg font-bold text-warning-fg"
                                : excluded
                                  ? "border-rule-strong text-ink"
                                  : "border-rule text-ink-3",
                            )}
                          >
                            <option value="" disabled>
                              {excluded ? "Choose a reason" : "Not excluded"}
                            </option>
                            {EXCLUSION_REASONS.map((option) => (
                              <option key={option} value={option}>
                                {reasonLabel(option)}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
