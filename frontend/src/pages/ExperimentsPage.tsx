import { useQuery } from "@tanstack/react-query";
import { CircleCheck, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { queries } from "@/api/queries";
import { ExperimentStatusBadge } from "@/components/badges";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as format from "@/lib/format";

export function ExperimentsPage() {
  const experiments = useQuery(queries.experiments());
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[1.75rem] leading-tight font-bold">Experiments</h1>
        <Button asChild className="px-3 font-bold">
          <Link to="/experiments/new">
            <Plus aria-hidden />
            New experiment
          </Link>
        </Button>
      </div>
      {experiments.isPending ? (
        <Loading label="Loading experiments…" />
      ) : experiments.isError ? (
        <ErrorState title="Experiments could not load" error={experiments.error} onRetry={() => experiments.refetch()} />
      ) : experiments.data.length === 0 ? (
        <EmptyState title="No experiments yet">Plan the first one with New experiment.</EmptyState>
      ) : (
        <div className="rounded-lg border border-rule bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Study type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Substrate</TableHead>
                <TableHead>Tissue lot</TableHead>
                <TableHead>Performed by</TableHead>
                <TableHead className="text-right">Measurements</TableHead>
                <TableHead>Results</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.data.map((experiment) => {
                const href = `/experiments/${experiment.id}/setup`;
                return (
                  <TableRow key={experiment.id} className="cursor-pointer" onClick={() => navigate(href)}>
                    <TableCell>
                      <Link
                        to={href}
                        onClick={(event) => event.stopPropagation()}
                        className="font-bold text-ballpoint underline-offset-2 hover:underline"
                      >
                        {experiment.code ?? `Experiment ${experiment.id}`}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-52 whitespace-normal">{experiment.title ?? "Untitled"}</TableCell>
                    <TableCell className="whitespace-normal">{format.humanize(experiment.study_type)}</TableCell>
                    <TableCell>
                      <ExperimentStatusBadge status={experiment.status} />
                    </TableCell>
                    <TableCell>{format.date(experiment.experiment_date) ?? "No date"}</TableCell>
                    <TableCell>{experiment.substrate ?? "Not recorded"}</TableCell>
                    <TableCell className="whitespace-normal">{experiment.tissue_lot ?? "Not recorded"}</TableCell>
                    <TableCell className="whitespace-normal">{experiment.performed_by ?? "Not recorded"}</TableCell>
                    <TableCell className="text-right">{experiment.n_measurements}</TableCell>
                    <TableCell>
                      {experiment.has_results ? (
                        <span className="inline-flex items-center gap-1 font-bold text-good-fg">
                          <CircleCheck aria-hidden className="size-4" />
                          Saved
                        </span>
                      ) : (
                        <span className="text-ink-3">Not saved</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
