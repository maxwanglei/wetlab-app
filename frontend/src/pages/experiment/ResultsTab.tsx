import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Download, Info, LoaderCircle, Save, TriangleAlert } from "lucide-react";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router";
import { errorMessage, type Schemas } from "@/api/client";
import { invalidateExperimentSummaries, mutations, queries } from "@/api/queries";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { percentLeft, type ArmStyle, type ExclusionReason } from "@/lib/domain";
import {
  draftFromResult,
  exclude,
  excludedIds,
  include,
  sameDraft,
  saveReadiness,
  type ExclusionDraft,
} from "@/lib/exclusions";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";
import { DepletionChart, describePoint, type PointRef } from "./DepletionChart";
import { PointsList } from "./PointsList";
import { ControlReadout, FmSummary, NegativeControlPanel } from "./ResultsPanels";
import { ResultsTable } from "./ResultsTable";

const NO_EXCLUSIONS: ExclusionDraft = new Map();

type ArmResult = Schemas["ArmResult"];

/** Notes for a reference readout: each negative control compared against it that lost parent. A negative
 * whose reference could not be chosen counts against every reference in its stage. */
function lostParent(arms: readonly ArmResult[], reference: ArmResult): string[] {
  return arms.flatMap((arm) => {
    const check = arm.negative_check;
    const against = arm.reference_key === reference.key || (arm.reference_key === null && arm.stage === reference.stage);
    if (!against || check?.verdict !== "flag" || check.percent_remaining_last === null || check.last_time_min === null) {
      return [];
    }
    return [`${arm.label} lost parent: ${percentLeft(check.percent_remaining_last)}% left at ${format.plain(check.last_time_min)} min`];
  });
}

export function ResultsTab({
  experiment,
  styles,
  edits,
  onEditsChange,
  active,
}: {
  experiment: Schemas["ExperimentDetail"];
  styles: ReadonlyMap<string, ArmStyle>;
  edits: ExclusionDraft | null;
  onEditsChange: Dispatch<SetStateAction<ExclusionDraft | null>>;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const saved = useQuery(queries.depletion(experiment.id));
  const savedDraft = useMemo(() => (saved.data ? draftFromResult(saved.data) : NO_EXCLUSIONS), [saved.data]);
  const draft = edits ?? savedDraft;
  const ids = useMemo(() => excludedIds(draft), [draft]);
  const preview = useQuery(queries.depletionPreview(experiment.id, ids, edits !== null && saved.isSuccess));
  const [announcement, setAnnouncement] = useState("");

  const save = useMutation({
    mutationFn: (exclusions: Schemas["Exclusion"][]) => mutations.saveDepletion(experiment.id, { exclusions }),
    onSuccess: (result, exclusions) => {
      queryClient.setQueryData(queries.depletion(experiment.id).queryKey, result);
      queryClient.removeQueries({ queryKey: ["experiments", experiment.id, "depletion", "preview"] });
      const submitted = new Map(exclusions.map(({ measurement_id, reason }) => [measurement_id, reason]));
      onEditsChange((current) => current === null || sameDraft(current, submitted) ? null : current);
      setAnnouncement("Results saved.");
      void queryClient.invalidateQueries({ queryKey: ["experiments", experiment.id, "measurements"] });
      void invalidateExperimentSummaries(queryClient, experiment.id);
    },
  });

  if (saved.isPending) return <Loading label="Fitting the depletion curves…" />;
  if (saved.isError) {
    return <ErrorState title="Results could not load" error={saved.error} onRetry={() => saved.refetch()} />;
  }

  const savedResult = saved.data;
  const result = edits === null ? savedResult : (preview.data ?? savedResult);
  const refitting = edits !== null && (preview.isFetching || preview.isPlaceholderData);
  const dirty = edits !== null && !sameDraft(edits, savedDraft);
  const readiness = saveReadiness(draft);
  const canSave = (dirty || savedResult.saved === null) && readiness.kind === "ready" && result.arms.length > 0;
  const references = result.arms.filter((arm) => arm.kind === "control");
  const byStage = new Set(references.map((arm) => arm.stage)).size > 1;

  function change(next: ExclusionDraft | null, message: string) {
    if (!save.isPending) save.reset();
    onEditsChange(next);
    setAnnouncement(message);
  }
  const excludePoint = (ref: PointRef, reason: ExclusionReason | null) =>
    change(exclude(draft, ref.point.measurement_id, reason), `Excluded ${describePoint(ref)}${reason ? ` (${reason})` : ""}. Refitting.`);
  const includePoint = (ref: PointRef) =>
    change(include(draft, ref.point.measurement_id), `Included ${describePoint(ref)} again. Refitting.`);

  if (savedResult.arms.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState title="No measurements to fit yet">
          Paste this experiment's parent-remaining data on the{" "}
          <Link to={`/experiments/${experiment.id}/bench`} className="font-bold text-ballpoint underline underline-offset-2">
            Bench data tab
          </Link>
          , and the depletion fits appear here.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-rule bg-surface px-4 py-2">
        <p className="text-[0.9375rem]">
          {savedResult.saved ? (
            <>
              Last saved <time dateTime={savedResult.saved.computed_at}>{format.dateTime(savedResult.saved.computed_at)}</time>
              {savedResult.saved.computed_by ? <> by {savedResult.saved.computed_by}</> : null}
            </>
          ) : (
            <span className="text-ink-2">Not saved yet</span>
          )}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
          {refitting ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              Refitting
            </span>
          ) : null}
          {readiness.kind === "missing-reasons" ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-bold text-warning-fg">
              <TriangleAlert aria-hidden className="size-4" />
              Choose a reason for {format.count(readiness.measurementIds.length, "excluded point")}
            </span>
          ) : null}
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-line bg-warning-bg px-2.5 py-0.5 text-sm font-bold text-warning-fg">
              <span aria-hidden className="size-2 rounded-full bg-[#d99a00]" />
              Unsaved changes
            </span>
          ) : null}
          {save.isSuccess && !dirty ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-sm font-bold text-good-fg">
              <CircleCheck aria-hidden className="size-4" />
              Saved with {format.count(draft.size, "exclusion")}
            </span>
          ) : null}
          {save.isError ? <span className="text-sm font-bold text-critical-fg">{errorMessage(save.error)}</span> : null}
          {dirty ? (
            <Button variant="ghost" onClick={() => change(null, "Changes discarded.")}>
              Discard changes
            </Button>
          ) : null}
          <Button
            data-testid="save-results"
            disabled={!canSave || save.isPending}
            onClick={() => {
              if (readiness.kind === "ready") save.mutate(readiness.exclusions);
            }}
          >
            <Save aria-hidden />
            {save.isPending ? "Saving…" : "Save results"}
          </Button>
          <Button asChild variant="outline" title="Every measurement with its stage, control, reference, internal standard and lots, for Excel and Prism">
            <a href={`/api/experiments/${experiment.id}/export.csv`} download>
              <Download aria-hidden />
              Download CSV
            </a>
          </Button>
        </div>
      </div>

      {preview.isError ? (
        <ErrorState
          title="The refit failed"
          error={preview.error}
          onRetry={() => preview.refetch()}
        />
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-12">
        <section aria-label="Depletion plot" className="space-y-4 rounded-lg border border-rule bg-surface p-4 xl:col-span-8">
          {active ? <DepletionChart
            result={result}
            draft={draft}
            styles={styles}
            onExclude={(ref, reason) => excludePoint(ref, reason)}
            onInclude={includePoint}
          /> : null}
          <PointsList
            arms={result.arms}
            draft={draft}
            styles={styles}
            onExcludedChange={(ref, excluded) => (excluded ? excludePoint(ref, null) : includePoint(ref))}
            onReasonChange={(ref, reason) => excludePoint(ref, reason)}
          />
        </section>
        <div className={cn("space-y-6 transition-opacity xl:col-span-4", refitting && "opacity-60")}>
          {references.map((control, index) => (
            <div key={control.key} className="space-y-2">
              {byStage && control.stage !== references[index - 1]?.stage && control.stage ? (
                <h2 className="text-xs font-bold tracking-wide text-ink-3 uppercase">{format.humanize(control.stage)} stage</h2>
              ) : null}
              <ControlReadout
                control={control}
                saved={savedResult.arms.find((arm) => arm.key === control.key) ?? null}
                showWas={dirty}
                style={styles.get(control.key)}
                notes={lostParent(result.arms, control)}
              />
            </div>
          ))}
          <FmSummary result={result} styles={styles} />
          <NegativeControlPanel arms={result.arms} styles={styles} />
        </div>
      </div>

      <div className={cn("transition-opacity", refitting && "opacity-60")}>
        <ResultsTable result={result} saved={savedResult} showWas={dirty} styles={styles} />
      </div>

      <section aria-labelledby="method-heading" className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 id="method-heading" className="text-sm font-bold text-ink-2">
            Method
          </h2>
          <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-2">{result.method}</p>
        </div>
        <div>
          <h2 className="text-sm font-bold text-ink-2">Problems</h2>
          {result.problems.length === 0 ? (
            <p className="mt-1 text-sm text-ink-3">None reported for this fit.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {result.problems.map((problem, index) => (
                <li key={`${index}-${problem}`} className="flex items-start gap-1.5 text-warning-fg">
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {problem}
                </li>
              ))}
            </ul>
          )}
          {result.checks.length > 0 ? (
            <>
              <h2 className="mt-4 text-sm font-bold text-ink-2">Checks</h2>
              <ul data-testid="checks" className="mt-1 space-y-1 text-sm">
                {result.checks.map((check, index) => (
                  <li key={`${index}-${check}`} className="flex items-start gap-1.5 text-ink-2">
                    <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                    {check}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** A single endpoint is recorded but not yet analysed; its raw reads are a tab away and in the CSV. */
export function EndpointResultsNotice({ experiment }: { experiment: Schemas["ExperimentDetail"] }) {
  return (
    <div className="space-y-4">
      <EmptyState title="Analysis for single-endpoint experiments is not built yet">
        The raw area ratios are on the{" "}
        <Link to={`/experiments/${experiment.id}/bench`} className="font-bold text-ballpoint underline underline-offset-2">
          Bench data tab
        </Link>{" "}
        and in the CSV, one row per well and analyte.
      </EmptyState>
      <Button asChild variant="outline" title="Every measurement with its analyte, condition, time, stage and lots, for Excel and Prism">
        <a href={`/api/experiments/${experiment.id}/export.csv`} download>
          <Download aria-hidden />
          Download CSV
        </a>
      </Button>
    </div>
  );
}
