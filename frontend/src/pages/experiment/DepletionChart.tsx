import type { Data, Layout, PlotMouseEvent } from "plotly.js";
import { Fragment, useMemo, useRef, useState, type FormEvent } from "react";
import type { Schemas } from "@/api/client";
import { ArmSwatch } from "@/components/ArmSwatch";
import { Plot } from "@/components/Plot";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  CHART_EXCLUDED,
  CHART_INK,
  EXCLUSION_REASONS,
  reasonLabel,
  type ArmStyle,
  type ExclusionReason,
} from "@/lib/domain";
import type { ExclusionDraft } from "@/lib/exclusions";
import * as format from "@/lib/format";

type ArmResult = Schemas["ArmResult"];
type PointOut = Schemas["PointOut"];

export type PointRef = { arm: ArmResult; point: PointOut };

export function describePoint({ arm, point }: PointRef): string {
  return `${arm.label} R${point.replicate} at ${format.plain(point.timepoint)} min`;
}

const FONT = "Red Hat Text Variable, ui-sans-serif, system-ui, sans-serif";
const HEIGHT = 420;
const LOG_TICKS = [1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 200, 300, 500];
const FALLBACK_STYLE: ArmStyle = { color: CHART_INK, symbol: "circle", muted: false, dashed: false };
const EXCLUDED_STYLE: ArmStyle = { color: CHART_EXCLUDED, symbol: "circle", muted: true, dashed: false };

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Muted arms, negative controls among them, first and reference controls last, so references draw on top. */
function drawRank(arm: ArmResult, style: ArmStyle): number {
  if (arm.kind === "control") return 2;
  return style.muted ? 0 : 1;
}

function hoverText(arm: ArmResult, point: PointOut, reason: ExclusionReason | null | undefined): string {
  const head = `<b>${escapeHtml(arm.label)}</b> R${point.replicate}<br>${format.plain(point.timepoint)} min: ${format.fixed(point.percent_of_t0, 2)}% of T0`;
  if (reason === undefined) return `${head}<br>Click to exclude this point`;
  return `${head}<br>Excluded${reason ? ` (${reason})` : ", reason not chosen"}. Click to include it again`;
}

function chartData(arms: ArmResult[], draft: ExclusionDraft, styles: ReadonlyMap<string, ArmStyle>, selected: PointRef | null): Data[] {
  const ordered = arms
    .map((arm) => ({ arm, style: styles.get(arm.key) ?? FALLBACK_STYLE }))
    .sort((a, b) => drawRank(a.arm, a.style) - drawRank(b.arm, b.style));

  const fitLines: Data[] = ordered.flatMap(({ arm, style }) =>
    arm.fit.fit_line.length < 2
      ? []
      : [
          {
            type: "scatter",
            mode: "lines",
            name: `${arm.label} fit`,
            x: arm.fit.fit_line.map(([time]) => time),
            y: arm.fit.fit_line.map(([, percent]) => percent),
            line: { color: style.color, width: style.muted ? 1.75 : 2.25, dash: style.dashed ? "dash" : "solid" },
            hoverinfo: "skip",
            showlegend: false,
          },
        ],
  );

  const points: Data[] = ordered.map(({ arm, style }) => {
    const excluded = arm.points.map((point) => draft.has(point.measurement_id));
    return {
      type: "scatter",
      mode: "markers",
      name: arm.label,
      x: arm.points.map((point) => point.timepoint),
      y: arm.points.map((point) => point.percent_of_t0),
      customdata: arm.points.map((point) => point.measurement_id),
      text: arm.points.map((point) =>
        hoverText(arm, point, draft.has(point.measurement_id) ? draft.get(point.measurement_id) : undefined),
      ),
      hovertemplate: "%{text}<extra></extra>",
      marker: {
        size: 10,
        symbol: excluded.map((isExcluded) => (isExcluded ? `${style.symbol}-open` : style.symbol)),
        color: excluded.map((isExcluded) => (isExcluded ? CHART_EXCLUDED : style.color)),
        line: { width: 1.5, color: excluded.map((isExcluded) => (isExcluded ? CHART_EXCLUDED : "#ffffff")) },
      },
      showlegend: false,
    };
  });

  const selection: Data[] = selected
    ? [
        {
          type: "scatter",
          mode: "markers",
          x: [selected.point.timepoint],
          y: [selected.point.percent_of_t0],
          marker: { size: 22, symbol: "circle-open", color: CHART_INK, line: { width: 2, color: CHART_INK } },
          hoverinfo: "skip",
          showlegend: false,
        },
      ]
    : [];

  return [...fitLines, ...points, ...selection];
}

function chartLayout(arms: ArmResult[]): Partial<Layout> {
  const values = arms.flatMap((arm) => arm.points.map((point) => point.percent_of_t0)).filter((value) => value > 0);
  const times = [...new Set(arms.flatMap((arm) => arm.points.map((point) => point.timepoint)))].sort((a, b) => a - b);
  const low = Math.min(10, ...values.map((value) => value * 0.85));
  const high = Math.max(120, ...values.map((value) => value * 1.15));
  const firstTime = times[0] ?? 0;
  const lastTime = times.at(-1) ?? 60;
  const pad = Math.max(1.5, (lastTime - firstTime) * 0.04);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const axis = {
    showline: true,
    linecolor: "#c4ccd2",
    gridcolor: "#e6eaef",
    zeroline: false,
    ticks: "outside" as const,
    tickcolor: "#c4ccd2",
    ticklen: 4,
    tickfont: { size: 13, color: "#3c4a5e" },
    fixedrange: true,
  };
  return {
    margin: { l: 64, r: 16, t: 10, b: 52 },
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { family: FONT, size: 13, color: "#3c4a5e" },
    hovermode: "closest",
    hoverdistance: 24,
    hoverlabel: { bgcolor: "#ffffff", bordercolor: "#c4ccd2", font: { family: FONT, size: 14, color: CHART_INK }, align: "left" },
    dragmode: false,
    showlegend: false,
    transition: { duration: reduceMotion ? 0 : 450, easing: "cubic-in-out" },
    xaxis: {
      ...axis,
      title: { text: "Time (min)", standoff: 10, font: { size: 14, color: "#3c4a5e" } },
      range: [firstTime - pad, lastTime + pad],
      tickvals: times,
    },
    yaxis: {
      ...axis,
      type: "log",
      title: { text: "% of T0, log scale", standoff: 8, font: { size: 14, color: "#3c4a5e" } },
      range: [Math.log10(low), Math.log10(high)],
      tickvals: LOG_TICKS.filter((tick) => tick >= low && tick <= high),
    },
  };
}

type PendingExclusion = PointRef & { x: number; y: number; side: "left" | "right"; reason: ExclusionReason | null };

export function DepletionChart({
  result,
  draft,
  styles,
  onExclude,
  onInclude,
}: {
  result: Schemas["DepletionResult"];
  draft: ExclusionDraft;
  styles: ReadonlyMap<string, ArmStyle>;
  onExclude: (ref: PointRef, reason: ExclusionReason) => void;
  onInclude: (ref: PointRef) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingExclusion | null>(null);

  const pointsById = useMemo(
    () =>
      new Map(
        result.arms.flatMap((arm) => arm.points.map((point) => [point.measurement_id, { arm, point }] as const)),
      ),
    [result.arms],
  );
  const data = useMemo(() => chartData(result.arms, draft, styles, pending), [result.arms, draft, styles, pending]);
  const layout = useMemo(() => chartLayout(result.arms), [result.arms]);
  const byStage = new Set(result.arms.map((arm) => arm.stage)).size > 1;

  function handlePointClick(event: PlotMouseEvent) {
    const clicked = event.points.find((point) => typeof point.customdata === "number");
    if (!clicked || typeof clicked.customdata !== "number") return;
    const ref = pointsById.get(clicked.customdata);
    if (!ref) return;
    if (draft.has(ref.point.measurement_id)) {
      setPending(null);
      onInclude(ref);
      return;
    }
    const bounds = frame.current?.getBoundingClientRect();
    const x = bounds ? event.event.clientX - bounds.left : 0;
    setPending({
      ...ref,
      x,
      y: bounds ? event.event.clientY - bounds.top : 0,
      side: bounds && x > bounds.width / 2 ? "left" : "right",
      reason: null,
    });
  }

  function confirmExclusion(event: FormEvent) {
    event.preventDefault();
    if (!pending?.reason) return;
    onExclude(pending, pending.reason);
    setPending(null);
  }

  return (
    <figure className="m-0">
      <ul aria-label="Legend" className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        {result.arms.map((arm, index) => {
          const style = styles.get(arm.key) ?? FALLBACK_STYLE;
          const stageStarts = byStage && arm.stage !== result.arms[index - 1]?.stage;
          return (
            <Fragment key={arm.key}>
              {stageStarts && arm.stage ? (
                <li className="basis-full pt-1 text-xs font-bold tracking-wide text-ink-3 uppercase first:pt-0">
                  {format.humanize(arm.stage)} stage
                </li>
              ) : null}
              <li className="flex items-center gap-1.5">
                <ArmSwatch style={style} />
                <span className={arm.kind === "control" ? "font-bold text-ink" : undefined}>{arm.label}</span>
                {arm.target_enzyme ? <span className="text-ink-3">{arm.target_enzyme}</span> : null}
              </li>
            </Fragment>
          );
        })}
        <li className="flex items-center gap-1.5">
          <ArmSwatch style={EXCLUDED_STYLE} hollow />
          <span>Excluded, not fitted</span>
        </li>
      </ul>

      <div ref={frame} className="relative">
        <Plot
          data={data}
          layout={layout}
          height={HEIGHT}
          onPointClick={handlePointClick}
          label={`Semi-log depletion plot: % of T0 against time for ${result.arms.length} arms, with each arm's pooled fit line. Use the Points list below to exclude points with the keyboard.`}
        />
        <Popover
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
        >
          <PopoverAnchor asChild>
            <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: pending?.x ?? 0, top: pending?.y ?? 0 }} />
          </PopoverAnchor>
          <PopoverContent side={pending?.side ?? "right"} align="start" sideOffset={14} className="w-72 gap-3">
            {pending ? (
              <form onSubmit={confirmExclusion} className="flex flex-col gap-3">
                <div>
                  <p className="font-bold text-ink">Exclude this point?</p>
                  <p className="text-ink-2">
                    {pending.arm.label} R{pending.point.replicate}, {format.plain(pending.point.timepoint)} min
                  </p>
                  <p className="text-ink-2 tabular-nums">{format.fixed(pending.point.percent_of_t0, 2)}% of T0</p>
                </div>
                <fieldset>
                  <legend className="mb-1 text-sm font-bold text-ink-2">Reason</legend>
                  <div className="grid gap-0.5">
                    {EXCLUSION_REASONS.map((reason) => (
                      <label
                        key={reason}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-paper has-checked:bg-paper has-checked:font-bold"
                      >
                        <input
                          type="radio"
                          name="exclusion-reason"
                          value={reason}
                          checked={pending.reason === reason}
                          onChange={() => setPending({ ...pending, reason })}
                          className="size-4 accent-ink"
                        />
                        {reasonLabel(reason)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="flex gap-2">
                  <Button type="submit" disabled={!pending.reason}>
                    Exclude point
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setPending(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      <figcaption className="mt-1 text-sm text-ink-3">
        Click a point to exclude it from its arm's fit; click a hollow point to include it again. Lines are the pooled
        ln-linear fit for each arm over its included points.
      </figcaption>
    </figure>
  );
}
