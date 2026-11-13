import { useState } from "react";
import type { Schemas } from "@/api/client";
import { ArmSwatch } from "@/components/ArmSwatch";
import { ArmKindBadge } from "@/components/badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { percentLeft, type ArmStyle } from "@/lib/domain";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";

type ArmResult = Schemas["ArmResult"];

/** Highlights a value when it changes after the first render, so a refit shows what moved. */
export function ChangedValue({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const [shown, setShown] = useState({ text, changed: false });
  if (shown.text !== text) setShown({ text, changed: true });
  return (
    <span key={shown.text} data-testid={testId} className={cn(shown.changed && "value-changed", className)}>
      {text}
    </span>
  );
}

function Was({ current, saved, show }: { current: string; saved: string | null; show: boolean }) {
  if (!show || saved === null || saved === current) return null;
  return <span className="block text-xs font-normal text-ink-3">was {saved}</span>;
}

export const fits = {
  k: (arm: ArmResult) => (arm.fit.k !== null ? format.significant(arm.fit.k, 3) : null),
  halfLife: (arm: ArmResult) => (arm.fit.half_life_min !== null ? format.fixed(arm.fit.half_life_min, 1) : null),
  clint: (arm: ArmResult) => (arm.fit.clint_app !== null ? format.fixed(arm.fit.clint_app, 1) : null),
  clintSd: (arm: ArmResult) => (arm.fit.clint_app_sd !== null ? format.fixed(arm.fit.clint_app_sd, 1) : null),
  clintU: (arm: ArmResult) => (arm.fit.clint_u !== null ? format.fixed(arm.fit.clint_u, 1) : null),
  rSquared: (arm: ArmResult) => (arm.fit.r_squared !== null ? format.fixed(arm.fit.r_squared, 3) : null),
  inhibition: (arm: ArmResult) => (arm.inhibition ? format.fixed(arm.inhibition.percent, 1) : null),
  inhibitionSe: (arm: ArmResult) => (arm.inhibition ? format.fixed(arm.inhibition.se, 1) : null),
  fm: (arm: ArmResult) =>
    arm.inhibition?.fm_apparent !== null && arm.inhibition?.fm_apparent !== undefined
      ? format.fixed(arm.inhibition.fm_apparent, 2)
      : null,
  t0: (arm: ArmResult) => (arm.fit.t0_backextrapolated !== null ? format.fixed(arm.fit.t0_backextrapolated, 1) : null),
};

const NONE = <span className="text-ink-3">–</span>;

/** How an arm's reference was chosen, after its label: matched by solvent says nothing more. */
const REFERENCE_NOTE: Record<NonNullable<ArmResult["reference_source"]>, string> = {
  matched: "",
  explicit: ", chosen on the arm",
  fallback: ", the stage's only reference",
};

function Measured({
  current,
  saved,
  showWas,
  spread,
  testId,
}: {
  current: string | null;
  saved: string | null;
  showWas: boolean;
  spread?: string | null;
  testId?: string;
}) {
  if (current === null) return NONE;
  return (
    <>
      <span className="inline-flex items-baseline justify-end">
        <ChangedValue text={current} testId={testId} />
        {spread !== undefined ? (
          <span className={cn("ml-1.5 inline-flex items-baseline gap-1 font-normal text-ink-2", spread === null && "invisible")}>
            ±<span className="inline-block min-w-[4ch] text-right">{spread !== null ? <ChangedValue text={spread} /> : null}</span>
          </span>
        ) : null}
      </span>
      <Was current={current} saved={saved} show={showWas} />
    </>
  );
}

export function ResultsTable({
  result,
  saved,
  showWas,
  styles,
}: {
  result: Schemas["DepletionResult"];
  saved: Schemas["DepletionResult"];
  showWas: boolean;
  styles: ReadonlyMap<string, ArmStyle>;
}) {
  const savedArm = (key: string) => saved.arms.find((arm) => arm.key === key) ?? null;
  const pick = (key: string, read: (arm: ArmResult) => string | null) => {
    const arm = savedArm(key);
    return arm ? read(arm) : null;
  };
  const anyExtrapolated = result.arms.some((arm) => arm.fit.half_life_extrapolated);
  const anyNotSignificant = result.arms.some((arm) => arm.inhibition && !arm.inhibition.significant);

  return (
    <section aria-labelledby="results-heading" className="rounded-lg border border-rule bg-surface">
      <div className="px-5 pt-4 pb-1">
        <h2 id="results-heading" className="text-base font-bold">
          Per-arm results
        </h2>
        <p className="mt-1 text-sm text-ink-3 sm:hidden">Swipe the table sideways to see every column.</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Arm</TableHead>
            <TableHead className="text-right">
              k<span className="block font-normal text-ink-3">min<sup>−1</sup></span>
            </TableHead>
            <TableHead className="text-right">
              t½<span className="block font-normal text-ink-3">min</span>
            </TableHead>
            <TableHead className="text-right">
              CL<sub>int,app</sub>
              <span className="block font-normal text-ink-3">µL/min/mg protein</span>
            </TableHead>
            <TableHead className="text-right">
              CL<sub>int,u</sub>
              <span className="block font-normal text-ink-3">
                f<sub>u,inc</sub>{" "}
                {result.fu_inc === null
                  ? "not set, assumed"
                  : result.fu_inc_withheld
                    ? `${format.fixed(result.fu_inc, 2)}, primary stage only`
                    : `${format.fixed(result.fu_inc, 2)}, assumed`}
              </span>
            </TableHead>
            <TableHead className="text-right">
              r²<span className="block font-normal text-ink-3">pooled fit</span>
            </TableHead>
            <TableHead className="text-right">
              Inhibition<span className="block font-normal text-ink-3">% ± SE</span>
            </TableHead>
            <TableHead>
              Apparent f<sub>m</sub>
              <span className="block font-normal text-ink-3">target enzyme</span>
            </TableHead>
            <TableHead className="pr-5 text-right">
              QC<span className="block font-normal text-ink-3">T0 back-extrapolated</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.arms.map((arm) => {
            const style = styles.get(arm.key);
            const isControl = arm.kind === "control";
            const isNegative = arm.kind === "negative_control";
            const inhibition = arm.inhibition;
            const check = arm.negative_check;
            const correction = arm.cofactor_correction;
            const lastTime = arm.fit.window_min?.[1];
            return (
              <TableRow key={arm.key} className="align-top">
                <TableCell className="pl-5 align-top whitespace-normal">
                  <span className="flex items-center gap-2">
                    {style ? <ArmSwatch style={style} /> : null}
                    <span className="font-bold">{arm.label}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-sm text-ink-3">
                    <ArmKindBadge kind={arm.kind} />
                    {arm.target_enzyme ? <span>{arm.target_enzyme}</span> : null}
                    {arm.concentration !== null ? (
                      <span>{format.quantity(arm.concentration, arm.concentration_unit)}</span>
                    ) : null}
                  </span>
                  <span className="mt-1 block pl-6 text-sm text-ink-3">
                    {arm.fit.n_points} of {arm.points.length} points used
                  </span>
                  {isControl ? null : (
                    <span data-testid={`reference-${arm.key}`} className="mt-1 block pl-6 text-sm text-ink-3">
                      {arm.reference_label ? (
                        <>
                          vs {arm.reference_label}
                          {REFERENCE_NOTE[arm.reference_source ?? "matched"]}
                        </>
                      ) : (
                        <span className="text-warning-fg">no reference control</span>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right align-top">
                  <Measured current={fits.k(arm)} saved={pick(arm.key, fits.k)} showWas={showWas} />
                </TableCell>
                <TableCell className="text-right align-top">
                  <Measured current={fits.halfLife(arm)} saved={pick(arm.key, fits.halfLife)} showWas={showWas} />
                  {arm.fit.half_life_extrapolated ? (
                    <span className="mt-1 flex justify-end">
                      <span
                        className="rounded-full border border-warning-line bg-warning-bg px-2 py-0.5 text-xs font-bold text-warning-fg"
                        title={`Longer than the last included timepoint${lastTime !== undefined ? ` (${format.plain(lastTime)} min)` : ""}`}
                      >
                        extrapolated
                      </span>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right align-top text-[1rem] font-bold">
                  <Measured
                    current={fits.clint(arm)}
                    saved={pick(arm.key, fits.clint)}
                    showWas={showWas}
                    spread={fits.clintSd(arm)}
                    testId={`clint-${arm.key}`}
                  />
                </TableCell>
                <TableCell className="text-right align-top">
                  <Measured current={fits.clintU(arm)} saved={pick(arm.key, fits.clintU)} showWas={showWas} />
                </TableCell>
                <TableCell className="text-right align-top">
                  <Measured current={fits.rSquared(arm)} saved={pick(arm.key, fits.rSquared)} showWas={showWas} />
                  <span className="block text-xs text-ink-3">pooled, n = {arm.fit.n_points}</span>
                </TableCell>
                <TableCell className="text-right align-top">
                  {isControl ? (
                    <span className="text-sm text-ink-3">reference</span>
                  ) : isNegative ? (
                    <span className="text-sm text-ink-3">
                      {check?.percent_remaining_last !== null && check?.percent_remaining_last !== undefined
                        ? `${percentLeft(check.percent_remaining_last)}% left at ${format.plain(check.last_time_min ?? 0)} min`
                        : "negative control"}
                    </span>
                  ) : (
                    <>
                      <Measured
                        current={fits.inhibition(arm)}
                        saved={pick(arm.key, fits.inhibition)}
                        showWas={showWas}
                        spread={fits.inhibitionSe(arm)}
                      />
                      {inhibition ? (
                        <span className="mt-1 flex items-center justify-end gap-1.5 text-xs text-ink-3">
                          {inhibition.significant ? null : (
                            <span
                              className="rounded-full border border-neutral-line bg-neutral-bg px-1.5 py-0.5 font-bold text-neutral-fg"
                              title="Not significant: the 95% confidence interval includes 0"
                            >
                              n.s.
                            </span>
                          )}
                          <span>
                            95% CI {format.fixed(inhibition.ci_low, 1)} to {format.fixed(inhibition.ci_high, 1)}
                          </span>
                        </span>
                      ) : null}
                      {correction ? (
                        <span className="mt-1 block text-xs text-ink-3" title="Display only; the saved inhibition is not corrected">
                          {format.fixed(correction.remaining_activity * 100, 1)}%
                          {correction.se !== null ? ` ± ${format.fixed(correction.se * 100, 1)}` : ""} activity left, corrected by
                          the run without cofactor
                        </span>
                      ) : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  {isControl ? (
                    <span className="text-sm text-ink-3">reference</span>
                  ) : isNegative ? (
                    NONE
                  ) : fits.fm(arm) !== null ? (
                    <>
                      <span className="font-bold">
                        <ChangedValue text={fits.fm(arm) ?? ""} />
                      </span>{" "}
                      <span className="text-ink-2">{arm.target_enzyme}</span>
                      <Was current={fits.fm(arm) ?? ""} saved={pick(arm.key, fits.fm)} show={showWas} />
                      {inhibition && !inhibition.fm_counted && inhibition.fm_note ? (
                        <span className="block text-xs text-ink-3">not counted: {inhibition.fm_note}</span>
                      ) : null}
                    </>
                  ) : inhibition?.fm_note ? (
                    <span className="text-sm text-ink-2">{inhibition.fm_note}</span>
                  ) : inhibition && !inhibition.significant ? (
                    <span className="text-ink-2">not detectable (n.s.)</span>
                  ) : inhibition ? (
                    <span className="text-ink-2">not detectable</span>
                  ) : (
                    NONE
                  )}
                </TableCell>
                <TableCell className="pr-5 text-right align-top">
                  {fits.t0(arm) !== null ? (
                    <span className="text-ink-2">
                      <ChangedValue text={`${fits.t0(arm)}%`} />
                    </span>
                  ) : (
                    NONE
                  )}
                  {arm.fit.problem ? (
                    <span
                      className={cn(
                        "mt-1 block max-w-48 text-left text-sm whitespace-normal",
                        // Without its cofactor, little or no loss is the expected result rather than a fault.
                        arm.cofactor_omitted ? "text-ink-3" : "font-bold text-critical-fg",
                      )}
                    >
                      {arm.fit.problem}
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="space-y-1 border-t border-rule px-5 py-3 text-sm text-ink-2">
        <p>
          CL<sub>int,app</sub> is from the pooled fit; ± is the SD of the per-replicate fits. Inhibition is relative to
          each arm's reference control, ± SE by the delta method.
        </p>
        {anyExtrapolated ? (
          <p>
            <strong className="text-warning-fg">extrapolated</strong>: the half-life is longer than the last included
            timepoint.
          </p>
        ) : null}
        {anyNotSignificant ? (
          <p>
            <strong className="text-neutral-fg">n.s.</strong>: not significant, because the 95% confidence interval of
            the inhibition includes 0. No apparent f<sub>m</sub> is assigned.
          </p>
        ) : null}
      </div>
    </section>
  );
}
