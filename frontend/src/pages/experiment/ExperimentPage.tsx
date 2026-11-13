import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Link, Navigate, NavLink, useBeforeUnload, useBlocker, useParams } from "react-router";
import { ApiError, errorMessage, type Schemas } from "@/api/client";
import { invalidateExperimentSummaries, mutations, queries } from "@/api/queries";
import { NotFound } from "@/components/AppShell";
import { ExperimentStatusBadge } from "@/components/badges";
import { Select } from "@/components/form";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { armStyles, EXPERIMENT_STATUSES, experimentStatus, type ExperimentStatus } from "@/lib/domain";
import { draftFromResult, sameDraft, type ExclusionDraft } from "@/lib/exclusions";
import * as format from "@/lib/format";
import { parseId } from "@/lib/params";
import { cn } from "@/lib/utils";
import { BenchDataTab } from "./BenchDataTab";
import { EndpointResultsNotice, ResultsTab } from "./ResultsTab";
import { SetupTab } from "./SetupTab";

const TABS = [
  { slug: "setup", label: "Setup" },
  { slug: "bench", label: "Bench data" },
  { slug: "results", label: "Results" },
] as const;

type TabSlug = (typeof TABS)[number]["slug"];

function parseTab(raw: string | undefined): TabSlug | null {
  return TABS.find((tab) => tab.slug === raw)?.slug ?? null;
}

export function ExperimentPage() {
  const params = useParams();
  const experimentId = parseId(params.experimentId);
  const tab = parseTab(params.tab);
  if (experimentId === null) return <NotFound what="experiment" />;
  if (tab === null) return <Navigate to={`/experiments/${experimentId}/setup`} replace />;
  return <ExperimentWorkspace key={experimentId} experimentId={experimentId} tab={tab} />;
}

function ExperimentWorkspace({ experimentId, tab }: { experimentId: number; tab: TabSlug }) {
  const experiment = useQuery(queries.experiment(experimentId));
  const saved = useQuery({ ...queries.depletion(experimentId), enabled: experiment.data !== undefined && experiment.data.sampling !== "endpoint" });
  const [edits, setEdits] = useState<ExclusionDraft | null>(null);
  const [benchDirty, setBenchDirty] = useState(false);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set<TabSlug>());

  useEffect(() => {
    setVisitedTabs((previous) => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab]);

  const savedDraft = useMemo(() => (saved.data ? draftFromResult(saved.data) : null), [saved.data]);
  const exclusionsDirty = edits !== null && savedDraft !== null && !sameDraft(edits, savedDraft);
  const dirty = exclusionsDirty || benchDirty;
  const blocker = useBlocker(
    ({ nextLocation }) => dirty && !TABS.some((item) => nextLocation.pathname === `/experiments/${experimentId}/${item.slug}`),
  );
  useBeforeUnload(useCallback((event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  }, [dirty]));
  const styles = useMemo(() => armStyles(experiment.data?.arms ?? []), [experiment.data]);

  if (experiment.isPending) return <Loading label="Loading the experiment…" />;
  if (experiment.isError) {
    if (experiment.error instanceof ApiError && experiment.error.status === 404) return <NotFound what="experiment" />;
    return (
      <ErrorState title="This experiment could not load" error={experiment.error} onRetry={() => experiment.refetch()} />
    );
  }
  const detail = experiment.data;

  return (
    <div>
      <ExperimentHeader experiment={detail} />
      {blocker.state === "blocked" ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning-line bg-warning-bg px-4 py-3"
        >
          <p className="flex-1 text-warning-fg">
            <strong>Unsaved changes.</strong> Leaving now discards {benchDirty && exclusionsDirty ? "the bench data draft and exclusions" : benchDirty ? "the bench data draft" : "the exclusions on the Results tab"}.
          </p>
          <Button variant="outline" onClick={() => blocker.reset()}>
            Stay on this experiment
          </Button>
          <Button variant="destructive" onClick={() => blocker.proceed()}>
            Leave without saving
          </Button>
        </div>
      ) : null}
      <nav aria-label="Experiment sections" className="mt-4 flex gap-1 border-b border-rule">
        {TABS.map((item) => (
          <NavLink
            key={item.slug}
            to={`/experiments/${experimentId}/${item.slug}`}
            className={({ isActive }) =>
              cn(
                "relative -mb-px flex items-center gap-2 rounded-t-md px-4 py-2.5 text-[0.9375rem] font-bold text-ink-2 hover:text-ink",
                isActive && "border-x border-t border-rule bg-surface text-ink",
              )
            }
          >
            {item.label}
            {(item.slug === "results" && exclusionsDirty) || (item.slug === "bench" && benchDirty) ? (
              <span className="size-2 rounded-full bg-[#d99a00]" title="Unsaved changes">
                <span className="sr-only">(unsaved changes)</span>
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>
      <div className="pt-6">
        {tab === "setup" ? <SetupTab experiment={detail} styles={styles} /> : null}
        {tab === "bench" || visitedTabs.has("bench") ? (
          <div hidden={tab !== "bench"}>
            <BenchDataTab experiment={detail} styles={styles} onMeasurementsReplaced={() => setEdits(null)} onDraftChange={setBenchDirty} />
          </div>
        ) : null}
        {tab === "results" || visitedTabs.has("results") ? (
          <div hidden={tab !== "results"}>
            <ResultsContent experiment={detail} styles={styles} edits={edits} onEditsChange={setEdits} active={tab === "results"} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ResultsContent({
  experiment,
  styles,
  edits,
  onEditsChange,
  active,
}: {
  experiment: Schemas["ExperimentDetail"];
  styles: ReturnType<typeof armStyles>;
  edits: ExclusionDraft | null;
  onEditsChange: Dispatch<SetStateAction<ExclusionDraft | null>>;
  active: boolean;
}) {
  return experiment.sampling === "endpoint" ? (
    <EndpointResultsNotice experiment={experiment} />
  ) : (
    <ResultsTab experiment={experiment} styles={styles} edits={edits} onEditsChange={onEditsChange} active={active} />
  );
}

function ExperimentHeader({ experiment }: { experiment: Schemas["ExperimentDetail"] }) {
  const code = experiment.code ?? `Experiment ${experiment.id}`;
  const facts = [
    ["Study type", format.humanize(experiment.study_type)],
    ["Date", format.date(experiment.experiment_date) ?? "Not recorded"],
    ["Performed by", experiment.performed_by ?? "Not recorded"],
    [
      "Substrate",
      [experiment.substrate, format.quantities(experiment.substrate_concentrations)].filter(Boolean).join(", ") ||
        "Not recorded",
    ],
    ["Tissue lot", experiment.tissue_lot ?? "Not recorded"],
  ] as const;
  return (
    <header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <nav aria-label="Breadcrumb" className="text-[0.9375rem] text-ink-3">
          <Link to="/experiments" className="font-bold text-ballpoint underline-offset-2 hover:underline">
            Experiments
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span aria-current="page" className="text-lg font-bold tracking-wide text-ink">
            {code}
          </span>
        </nav>
        <ExperimentStatusBadge status={experiment.status} />
        <StatusChange experiment={experiment} />
        <Button asChild variant="outline" size="sm" className="font-bold">
          <Link to={`/experiments/${experiment.id}/edit`}>{experiment.has_bench_data ? "Edit details" : "Edit"}</Link>
        </Button>
      </div>
      <h1 className="mt-1 text-[1.75rem] leading-tight font-bold">{experiment.title ?? "Untitled experiment"}</h1>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-ink-3">{label}</dt>
            <dd className="text-[0.9375rem]">{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

/** Moves the experiment to another status. A move to a finished status is saved even when the record still
 * lacks something, such as who prepared a solution it cites; the warnings say what. */
function StatusChange({ experiment }: { experiment: Schemas["ExperimentDetail"] }) {
  const queryClient = useQueryClient();
  const current = EXPERIMENT_STATUSES.find((status) => status === experiment.status) ?? "planned";
  const [next, setNext] = useState<ExperimentStatus>(current);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // When the saved status changes, here or by a colleague, the select follows it.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setNext(current);
  }
  const change = useMutation({
    mutationFn: (status: ExperimentStatus) => mutations.changeStatus(experiment.id, { status }),
    onSuccess: async (result) => {
      setWarnings(result.warnings);
      await invalidateExperimentSummaries(queryClient, experiment.id);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    change.mutate(next);
  }

  return (
    <div className="ml-auto flex flex-col items-end gap-2">
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor="experiment-status" className="text-sm text-ink-3">
          Status
        </label>
        <Select
          id="experiment-status"
          value={next}
          onChange={(event) => setNext(EXPERIMENT_STATUSES.find((status) => status === event.target.value) ?? next)}
          className="w-auto"
        >
          {EXPERIMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {experimentStatus(status).label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline" disabled={next === experiment.status || change.isPending}>
          {change.isPending ? "Saving…" : "Change status"}
        </Button>
      </form>
      {change.isError ? <p className="text-sm font-bold text-critical-fg">{errorMessage(change.error)}</p> : null}
      {warnings.length > 0 ? (
        <ul role="status" data-testid="status-warnings" className="max-w-md space-y-1 rounded-md border border-warning-line bg-warning-bg px-3 py-2 text-sm">
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`} className="flex items-start gap-1.5 text-warning-fg">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
