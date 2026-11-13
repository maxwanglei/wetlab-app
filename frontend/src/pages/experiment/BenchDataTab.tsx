import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { useLocation } from "react-router";
import type { Schemas } from "@/api/client";
import { queries } from "@/api/queries";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { benchGrid } from "@/lib/bench-grid";
import type { ArmStyle } from "@/lib/domain";
import { readFlash } from "@/lib/flash";
import * as format from "@/lib/format";
import { EndpointBenchData } from "./EndpointBenchData";
import { PastePanel } from "./PastePanel";
import { WideGrid } from "./WideGrid";

type MeasurementRow = Schemas["MeasurementRow"];

function measurementCell(row: MeasurementRow | undefined) {
  if (!row) return { content: <span className="text-ink-3">–</span>, title: "No measurement" };
  const details = [
    row.raw_value !== null ? `Area ratio ${format.plain(row.raw_value)}` : null,
    row.well_position ? `well ${row.well_position}` : null,
  ].filter((part) => part !== null);
  if (row.percent_of_t0 === null) return { content: <span className="text-ink-3">–</span>, title: details.join(", ") };
  const value = format.fixed(row.percent_of_t0, 2);
  if (!row.is_excluded) return { content: value, title: details.join(", ") || undefined };
  const reason = row.exclusion_reason ?? "no reason recorded";
  return {
    content: (
      <>
        <span className="line-through decoration-1">{value}</span>
        <span className="sr-only">, excluded: {reason}</span>
      </>
    ),
    className: "bg-[repeating-linear-gradient(135deg,#f1f3f5_0_4px,#ffffff_4px_8px)] text-ink-3",
    title: [`Excluded: ${reason}`, ...details].join(", "),
  };
}

export function BenchDataTab({
  experiment,
  styles,
  onMeasurementsReplaced,
  onDraftChange,
}: {
  experiment: Schemas["ExperimentDetail"];
  styles: ReadonlyMap<string, ArmStyle>;
  onMeasurementsReplaced: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const measurements = useQuery(queries.measurements(experiment.id));
  const flash = readFlash(useLocation().state);
  const justPlanned =
    flash?.kind === "experiment-planned" && flash.experimentId === experiment.id && measurements.data?.rows.length === 0;

  return (
    <div className="space-y-8">
      {justPlanned ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-good-line bg-good-bg px-4 py-3">
          <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-good-fg" />
          <div>
            <p className="font-bold text-good-fg">{experiment.code ?? "The experiment"} is planned and ready for bench data.</p>
            <p className="text-sm text-ink">Copy the template below, fill it in Excel, then paste the block back here.</p>
          </div>
        </div>
      ) : null}
      {justPlanned && experiment.warnings.length > 0 ? (
        <div role="status" data-testid="planned-warnings" className="rounded-lg border border-warning-line bg-warning-bg px-4 py-3">
          <p className="font-bold text-warning-fg">Saved with {format.count(experiment.warnings.length, "note")} to check on the Setup tab:</p>
          <ul className="mt-1 space-y-1 text-sm text-ink">
            {experiment.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {experiment.sampling === "endpoint" ? (
        <EndpointBenchData experiment={experiment} styles={styles} onDraftChange={onDraftChange} />
      ) : (
        <TimeCourseBenchData experiment={experiment} styles={styles} onMeasurementsReplaced={onMeasurementsReplaced} onDraftChange={onDraftChange} />
      )}
    </div>
  );
}

function TimeCourseBenchData({
  experiment,
  styles,
  onMeasurementsReplaced,
  onDraftChange,
}: {
  experiment: Schemas["ExperimentDetail"];
  styles: ReadonlyMap<string, ArmStyle>;
  onMeasurementsReplaced: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const measurements = useQuery(queries.measurements(experiment.id));
  return (
    <>
      <section aria-labelledby="measurements-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="measurements-heading" className="text-lg font-bold">
            Parent remaining, % of T0
          </h2>
          {measurements.data && measurements.data.rows.length > 0 ? (
            <p className="text-sm text-ink-2">
              {format.count(measurements.data.rows.length, "measurement")}
              {", "}
              {format.count(measurements.data.rows.filter((row) => row.is_excluded).length, "exclusion")}. Each
              value is relative to its own replicate's T0. Struck-through values are excluded from the fit; hover a
              value for its reason, area ratio and well.
            </p>
          ) : null}
        </div>
        {measurements.isPending ? (
          <Loading label="Loading measurements…" />
        ) : measurements.isError ? (
          <ErrorState title="Measurements could not load" error={measurements.error} onRetry={() => measurements.refetch()} />
        ) : measurements.data.rows.length === 0 ? (
          <EmptyState title="No measurements yet">
            Paste a block copied from Excel below. Copy the template first to get the column order.
          </EmptyState>
        ) : (
          <WideGrid
            grid={benchGrid(measurements.data.arms, measurements.data.rows)}
            styles={styles}
            renderCell={measurementCell}
            caption={`Parent remaining as % of T0 for ${experiment.code ?? "this experiment"}, by timepoint, arm and replicate`}
          />
        )}
      </section>

      {measurements.data ? (
        <PastePanel
          experiment={experiment}
          measurements={measurements.data}
          styles={styles}
          onReplaced={onMeasurementsReplaced}
          onDraftChange={onDraftChange}
        />
      ) : null}
    </>
  );
}
