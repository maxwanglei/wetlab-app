import { Fragment, type ReactNode } from "react";
import { ArmSwatch } from "@/components/ArmSwatch";
import type { BenchGrid } from "@/lib/bench-grid";
import type { ArmStyle } from "@/lib/domain";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";

type GridRow = { arm_key: string; replicate: number; timepoint: number };

export function WideGrid<Row extends GridRow>({
  grid,
  styles,
  renderCell,
  caption,
}: {
  grid: BenchGrid<Row>;
  styles: ReadonlyMap<string, ArmStyle>;
  renderCell: (row: Row | undefined) => { content: ReactNode; className?: string; title?: string };
  caption: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
      <table className="w-full border-collapse text-[0.9375rem] tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-rule">
            <th rowSpan={2} scope="col" className="sticky left-0 bg-surface px-3 py-2 text-left align-bottom text-[0.8125rem] font-bold text-ink-2">
              Time
              <span className="block font-normal text-ink-3">min</span>
            </th>
            {grid.arms.map((arm) => {
              const style = styles.get(arm.key);
              return (
                <th
                  key={arm.key}
                  colSpan={grid.replicates.length}
                  scope="colgroup"
                  className="border-l border-rule px-3 pt-2 pb-1 text-left text-[0.8125rem] font-bold text-ink"
                >
                  <span className="flex items-center gap-1.5">
                    {style ? <ArmSwatch style={style} size={14} /> : null}
                    {arm.label}
                  </span>
                </th>
              );
            })}
          </tr>
          <tr className="border-b border-rule-strong">
            {grid.arms.map((arm) =>
              grid.replicates.map((replicate, index) => (
                <th
                  key={`${arm.key}-${replicate}`}
                  scope="col"
                  className={cn(
                    "px-3 pb-2 text-right text-[0.8125rem] font-bold text-ink-3",
                    index === 0 && "border-l border-rule",
                  )}
                >
                  R{replicate}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {grid.timepoints.map((timepoint) => (
            <tr key={timepoint} className="border-b border-rule last:border-b-0">
              <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-bold">
                {format.plain(timepoint)}
              </th>
              {grid.arms.map((arm) => (
                <Fragment key={arm.key}>
                  {grid.replicates.map((replicate, index) => {
                    const cell = renderCell(grid.cell(timepoint, arm.key, replicate));
                    return (
                      <td
                        key={replicate}
                        title={cell.title}
                        className={cn("px-3 py-2 text-right", index === 0 && "border-l border-rule", cell.className)}
                      >
                        {cell.content}
                      </td>
                    );
                  })}
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
