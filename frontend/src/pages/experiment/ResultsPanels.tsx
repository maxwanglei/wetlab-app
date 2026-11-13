import { TriangleAlert } from "lucide-react";
import type { Schemas } from "@/api/client";
import { ArmSwatch } from "@/components/ArmSwatch";
import { ToneBadge } from "@/components/badges";
import { ARM_KIND_LABEL, percentLeft, type ArmStyle, type Tone } from "@/lib/domain";
import * as format from "@/lib/format";
import { ChangedValue, fits } from "./ResultsTable";

type ArmResult = Schemas["ArmResult"];

/** One reference control's fit. `notes` names the negative controls compared against it that lost parent. */
export function ControlReadout({
  control,
  saved,
  showWas,
  style,
  notes = [],
}: {
  control: ArmResult;
  saved: ArmResult | null;
  showWas: boolean;
  style: ArmStyle | undefined;
  notes?: readonly string[];
}) {
  const clint = fits.clint(control);
  const sd = fits.clintSd(control);
  const savedClint = saved ? fits.clint(saved) : null;
  const facts = [
    ["t½", fits.halfLife(control), "min"],
    ["k", fits.k(control), "min⁻¹"],
    ["r²", fits.rSquared(control), `pooled, n = ${control.fit.n_points}`],
  ] as const;
  return (
    <section
      aria-labelledby={`readout-${control.key}`}
      data-testid={`readout-${control.key}`}
      className="rounded-lg border border-rule bg-surface p-5"
    >
      <h2 id={`readout-${control.key}`} className="flex items-center gap-2 font-bold">
        {style ? <ArmSwatch style={style} /> : null}
        {control.label}
      </h2>
      <p className="mt-0.5 text-sm text-ink-3">
        CL<sub>int,app</sub>, µL/min/mg protein
      </p>
      {clint !== null ? (
        <p className="mt-2 flex items-baseline gap-2">
          <ChangedValue text={clint} className="text-5xl leading-none font-bold text-ink" />
          {sd !== null ? <span className="text-xl text-ink-2">± {sd}</span> : null}
        </p>
      ) : (
        <p className="mt-2 font-bold text-critical-fg">{control.fit.problem ?? "No fit"}</p>
      )}
      {showWas && savedClint !== null && savedClint !== clint ? (
        <p className="mt-1.5 text-sm text-ink-2">was {savedClint} before these changes</p>
      ) : null}
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-rule pt-3">
        {facts.map(([label, value, note]) => (
          <div key={label}>
            <dt className="text-sm text-ink-3">{label}</dt>
            <dd className="text-lg font-bold tabular-nums">{value !== null ? <ChangedValue text={value} /> : "–"}</dd>
            <dd className="text-xs text-ink-3">{note}</dd>
          </div>
        ))}
      </dl>
      {notes.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-rule pt-3 text-sm">
          {notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5 text-warning-fg">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const UNASSIGNED_COLOR = "#dfe4e8";

export function FmSummary({ result, styles }: { result: Schemas["DepletionResult"]; styles: ReadonlyMap<string, ArmStyle> }) {
  const assigned = result.arms.filter((arm) => arm.inhibition?.fm_counted);
  const uncounted = result.arms.filter(
    (arm) => arm.inhibition && arm.inhibition.fm_apparent !== null && !arm.inhibition.fm_counted,
  );
  const unavailable = result.arms.filter((arm) => arm.inhibition && arm.inhibition.fm_apparent === null);
  const unassigned = result.fm_unassigned;
  const total = result.fm_total;
  const scale = total !== null && total > 1 ? total : 1;

  return (
    <section aria-labelledby="fm-heading" className="rounded-lg border border-rule bg-surface p-5">
      <h2 id="fm-heading" className="font-bold">
        Apparent f<sub>m</sub> by enzyme
      </h2>
      <p className="text-sm text-ink-3">From chemical inhibition of the vehicle-control rate.</p>

      {assigned.length === 0 ? (
        <p className="mt-3 text-ink-2">
          No individual enzyme fraction can be assigned
          {result.arms.some((arm) => arm.inhibition) ? "." : " yet: it needs a vehicle control and at least one inhibitor arm with a fit."}
        </p>
      ) : (
        <>
          <div aria-hidden className="mt-4 flex h-3 w-full gap-0.5 overflow-hidden rounded-sm">
            {assigned.map((arm) => (
              <span
                key={arm.key}
                className="h-full"
                style={{
                  width: `${((arm.inhibition?.fm_apparent ?? 0) / scale) * 100}%`,
                  background: styles.get(arm.key)?.color ?? "#485364",
                }}
              />
            ))}
            {unassigned !== null && unassigned > 0 ? (
              <span className="h-full flex-1" style={{ background: UNASSIGNED_COLOR }} />
            ) : null}
          </div>
          <table className="mt-3 w-full text-[0.9375rem] tabular-nums">
            <caption className="sr-only">Apparent fm per enzyme</caption>
            <tbody>
              {assigned.map((arm) => {
                const style = styles.get(arm.key);
                return (
                  <tr key={arm.key} className="border-b border-rule">
                    <th scope="row" className="py-2 pr-3 text-left font-bold">
                      <span className="flex items-center gap-2">
                        {style ? <ArmSwatch style={style} size={14} /> : null}
                        {arm.target_enzyme ?? "Unknown enzyme"}
                      </span>
                    </th>
                    <td className="py-2 pr-3 text-right text-lg font-bold">
                      <ChangedValue text={fits.fm(arm) ?? ""} />
                    </td>
                    <td className="py-2 text-sm text-ink-2">
                      {arm.label}, {format.quantity(arm.concentration, arm.concentration_unit) ?? "concentration not set"}
                    </td>
                  </tr>
                );
              })}
              {unassigned !== null ? (
                <tr className="border-b border-rule">
                  <th scope="row" className="py-2 pr-3 text-left font-bold">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="size-3.5 rounded-sm" style={{ background: UNASSIGNED_COLOR }} />
                      Unassigned
                    </span>
                  </th>
                  <td className="py-2 pr-3 text-right text-lg font-bold">
                    <ChangedValue text={format.fixed(unassigned, 2)} />
                  </td>
                  <td className="py-2 text-sm text-ink-2">not explained by the inhibitors tested</td>
                </tr>
              ) : null}
              {uncounted.map((arm) => (
                <tr key={arm.key} data-testid={`fm-uncounted-${arm.key}`} className="border-b border-rule">
                  <th scope="row" className="py-2 pr-3 text-left align-top font-bold text-ink-2">
                    {arm.target_enzyme ?? "Unknown enzyme"}
                  </th>
                  <td colSpan={2} className="py-2 text-sm text-ink-2">
                    {fits.fm(arm)} with {arm.label}, not counted: {arm.inhibition?.fm_note ?? "another arm counts this enzyme"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unassigned !== null && unassigned < 0 ? (
            <p className="mt-2 text-sm font-bold text-warning-fg">
              The apparent fractions add up to more than 1, which suggests at least one inhibitor is not selective.
            </p>
          ) : null}
        </>
      )}
      {unavailable.length > 0 ? (
        <ul className="mt-3 divide-y divide-rule border-y border-rule text-sm text-ink-2">
          {unavailable.map((arm) => (
            <li key={arm.key} className="py-2">
              <span className="font-bold">{arm.label}</span>,{" "}
              {format.quantity(arm.concentration, arm.concentration_unit) ?? "concentration not set"}: {arm.inhibition?.fm_note ?? (arm.inhibition?.significant ? "Not detectable" : "Not detectable (n.s.)")}
              {arm.kind === "selectivity_control" ? `; ${ARM_KIND_LABEL.selectivity_control.toLowerCase()}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-4 text-sm leading-relaxed text-ink-2">
        Apparent fm from chemical inhibition assumes complete, selective inhibition of the target enzyme at this
        concentration. Incomplete inhibition biases fm low; non-selective inhibition biases it high.
      </p>
    </section>
  );
}

const VERDICT: Record<Schemas["NegativeCheckOut"]["verdict"], { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "good" },
  flag: { label: "Lost parent", tone: "warning" },
  not_judged: { label: "Not judged", tone: "neutral" },
};

/** Each negative control's verdict: how much parent is left at its last timepoint, against the threshold
 * written into the method. A negative that loses parent is flagged for a look; nothing is subtracted. */
export function NegativeControlPanel({ arms, styles }: { arms: readonly ArmResult[]; styles: ReadonlyMap<string, ArmStyle> }) {
  const negatives = arms.filter((arm) => arm.negative_check);
  const threshold = negatives[0]?.negative_check?.threshold_percent;
  if (negatives.length === 0 || threshold === undefined) return null;
  return (
    <section aria-labelledby="negatives-heading" className="rounded-lg border border-rule bg-surface p-5">
      <h2 id="negatives-heading" className="font-bold">
        Negative controls
      </h2>
      <p className="text-sm text-ink-3">
        Pass with at least {format.plain(threshold)}% of T0 left at the last timepoint, or no measurable loss.
      </p>
      <ul className="mt-3 divide-y divide-rule">
        {negatives.map((arm) => {
          const check = arm.negative_check;
          if (!check) return null;
          const verdict = VERDICT[check.verdict];
          const style = styles.get(arm.key);
          return (
            <li key={arm.key} data-testid={`negative-${arm.key}`} className="py-2.5">
              <span className="flex items-center gap-2">
                {style ? <ArmSwatch style={style} size={14} /> : null}
                <span className="font-bold">{arm.label}</span>
                <ToneBadge tone={verdict.tone} className="ml-auto">
                  {verdict.label}
                </ToneBadge>
              </span>
              <span className="mt-1 block pl-6 text-sm text-ink-2 tabular-nums">
                {check.percent_remaining_last !== null && check.last_time_min !== null
                  ? `${percentLeft(check.percent_remaining_last)}% left at ${format.plain(check.last_time_min)} min, n = ${check.n_at_last}`
                  : "No timepoint after T0"}
                {check.k_ratio !== null && arm.reference_label
                  ? `; ${format.fixed(check.k_ratio, 2)}${check.k_ratio_se !== null ? ` ± ${format.fixed(check.k_ratio_se, 2)}` : ""} × the rate of ${arm.reference_label}`
                  : ""}
              </span>
              {check.dependent_share !== null ? (
                <span className="block pl-6 text-sm text-ink-3">
                  {format.fixed(check.dependent_share * 100, 0)}% of the reference loss needs the omitted cofactor
                </span>
              ) : null}
              {check.reason ? <span className="block pl-6 text-sm text-ink-3">{check.reason}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
