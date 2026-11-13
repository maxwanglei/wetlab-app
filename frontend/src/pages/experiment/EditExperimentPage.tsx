import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, errorMessage, type Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { NotFound } from "@/components/AppShell";
import { Input, ProblemAlert, Select } from "@/components/form";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseId } from "@/lib/params";
import { draftFromBody, experimentBody, sameRequest } from "@/pages/new-experiment/experiment-draft";
import { EDIT_WORDING, ExperimentForm } from "@/pages/new-experiment/NewExperimentPage";

export function EditExperimentPage() {
  const experimentId = parseId(useParams().experimentId);
  const experiment = useQuery({ ...queries.experiment(experimentId ?? 0), enabled: experimentId !== null });
  const reference = useQuery(queries.reference());
  if (experimentId === null) return <NotFound what="experiment" />;
  if (experiment.isPending || reference.isPending) return <Loading label="Loading the experiment…" />;
  if (experiment.isError) {
    if (experiment.error instanceof ApiError && experiment.error.status === 404) return <NotFound what="experiment" />;
    return <ErrorState title="The experiment could not load" error={experiment.error} onRetry={() => experiment.refetch()} />;
  }
  if (reference.isError) return <ErrorState title="The form's choices could not load" error={reference.error} onRetry={() => reference.refetch()} />;

  const detail = experiment.data;
  const back = `/experiments/${detail.id}/setup`;
  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
          <Link to="/experiments" className="font-bold text-ballpoint underline-offset-2 hover:underline">
            Experiments
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <Link to={back} className="font-bold text-ballpoint underline-offset-2 hover:underline">
            {detail.code ?? `Experiment ${detail.id}`}
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span aria-current="page">Edit</span>
        </nav>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold">Edit {detail.title ?? "experiment"}</h1>
        <p className="mt-1 max-w-[72ch] text-ink-2">
          {detail.has_bench_data
            ? "Bench data has been pasted against this design, so its stages, arms and controls stay as they are. Plan a new experiment to run a different design."
            : "Until bench data is pasted, every part of the design can change."}
        </p>
      </header>
      {detail.has_bench_data ? (
        <DetailsForm experiment={detail} members={reference.data.members} back={back} />
      ) : (
        <DesignForm experimentId={detail.id} reference={reference.data} back={back} />
      )}
    </div>
  );
}

function DesignForm({ experimentId, reference, back }: { experimentId: number; reference: Schemas["ReferenceData"]; back: string }) {
  const design = useQuery(queries.design(experimentId));
  const draft = useMemo(() => (design.data ? draftFromBody(design.data) : null), [design.data]);
  if (design.isPending) return <Loading label="Loading the design…" />;
  if (design.isError) return <ErrorState title="The design could not load" error={design.error} onRetry={() => design.refetch()} />;
  // The form must show the design exactly; one it can't, it doesn't offer to change.
  const parsed = draft ? experimentBody(draft, reference.reagent_lots) : null;
  if (!draft || !parsed?.ok || !sameRequest(parsed.body, design.data)) {
    return (
      <EmptyState title="This design can't be changed here">
        It was recorded with something the form has no field for. Plan a new experiment with the design you want.
      </EmptyState>
    );
  }
  return (
    <ExperimentForm
      reference={reference}
      initial={draft}
      save={(body) => mutations.replaceDesign(experimentId, body)}
      wording={EDIT_WORDING}
      cancelTo={back}
      onSaved={(_, navigate) => navigate(back)}
    />
  );
}

function DetailsForm({
  experiment,
  members,
  back,
}: {
  experiment: Schemas["ExperimentDetail"];
  members: readonly Schemas["NamedRef"][];
  back: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const alertRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(experiment.title ?? "");
  const [objective, setObjective] = useState(experiment.objective ?? "");
  const [date, setDate] = useState(experiment.experiment_date ?? "");
  const [performedBy, setPerformedBy] = useState(experiment.performed_by_id === null ? "" : String(experiment.performed_by_id));
  const save = useMutation({
    mutationFn: () =>
      mutations.updateDetails(experiment.id, {
        title,
        objective: objective.trim() || null,
        experiment_date: date || null,
        performed_by: performedBy ? Number(performedBy) : null,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queries.experiment(saved.id).queryKey, saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["experiments"], exact: true }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      void navigate(back);
    },
    onError: () => requestAnimationFrame(() => alertRef.current?.focus()),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4 rounded-lg border border-rule bg-surface p-5">
      <ProblemAlert title="The changes were not saved" message={save.isError ? errorMessage(save.error) : null} alertRef={alertRef} />
      <div className="flex flex-col gap-1">
        <label htmlFor="details-title" className="text-sm font-bold text-ink-2">
          Title
        </label>
        <Input id="details-title" required value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="details-objective" className="text-sm font-bold text-ink-2">
          Objective
        </label>
        <Textarea id="details-objective" value={objective} onChange={(event) => setObjective(event.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="details-date" className="text-sm font-bold text-ink-2">
            Date
          </label>
          <Input id="details-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="details-performed-by" className="text-sm font-bold text-ink-2">
            Performed by
          </label>
          <Select id="details-performed-by" value={performedBy} onChange={(event) => setPerformedBy(event.target.value)}>
            <option value="">Not recorded</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex gap-3">
        <Button type="submit" className="font-bold" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button asChild variant="outline">
          <Link to={back}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
