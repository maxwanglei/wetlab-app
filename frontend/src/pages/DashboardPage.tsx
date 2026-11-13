import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Schemas } from "@/api/client";
import { queries } from "@/api/queries";
import { ExperimentStatusBadge, LotFlagBadges } from "@/components/badges";
import { EmptyState, ErrorState, Loading, Meter } from "@/components/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { experimentStatus } from "@/lib/domain";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";

export function DashboardPage() {
  const dashboard = useQuery(queries.dashboard());
  return (
    <div className="space-y-8">
      <h1 className="text-[1.75rem] leading-tight font-bold">Dashboard</h1>
      {dashboard.isPending ? (
        <Loading label="Loading the dashboard…" />
      ) : dashboard.isError ? (
        <ErrorState title="The dashboard could not load" error={dashboard.error} onRetry={() => dashboard.refetch()} />
      ) : (
        <>
          <StatusCounts counts={dashboard.data.experiments_by_status} />
          <div className="grid gap-8 lg:grid-cols-12">
            <RecentExperiments experiments={dashboard.data.recent_experiments} />
            <LotAlerts alerts={dashboard.data.lot_alerts} />
          </div>
        </>
      )}
    </div>
  );
}

function StatusCounts({ counts }: { counts: Schemas["StatusCount"][] }) {
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <section aria-labelledby="status-heading">
      <h2 id="status-heading" className="mb-3 text-lg font-bold">
        Experiments by status <span className="font-normal text-ink-3">({total} in total)</span>
      </h2>
      <ul className="grid grid-cols-2 overflow-hidden rounded-lg border border-rule bg-surface sm:grid-cols-3 lg:grid-cols-6">
        {counts.map(({ status, count }) => {
          const meta = experimentStatus(status);
          const Icon = meta.icon;
          return (
            <li key={status} className="border-rule px-4 py-3 not-last:border-r max-lg:border-b">
              <span className={cn("flex items-center gap-1.5 text-sm font-bold", count ? "text-ink-2" : "text-ink-3")}>
                <Icon aria-hidden className="size-4" />
                {meta.label}
              </span>
              <span className={cn("mt-1 block text-[2rem] leading-none font-bold", count ? "text-ink" : "text-ink-3")}>
                {count}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RecentExperiments({ experiments }: { experiments: Schemas["ExperimentSummary"][] }) {
  return (
    <section aria-labelledby="recent-heading" className="lg:col-span-7">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="recent-heading" className="text-lg font-bold">
          Recent experiments
        </h2>
        <Link to="/experiments" className="text-sm font-bold text-ballpoint underline-offset-2 hover:underline">
          All experiments
        </Link>
      </div>
      {experiments.length === 0 ? (
        <EmptyState title="No experiments yet" />
      ) : (
        <div className="rounded-lg border border-rule bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Experiment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.map((experiment) => (
                <TableRow key={experiment.id}>
                  <TableCell className="whitespace-normal">
                    <Link
                      to={`/experiments/${experiment.id}/setup`}
                      className="font-bold text-ballpoint underline-offset-2 hover:underline"
                    >
                      {experiment.code ?? `Experiment ${experiment.id}`}
                    </Link>
                    <span className="block text-ink">{experiment.title}</span>
                    <span className="block text-sm text-ink-3 sm:hidden">
                      {format.date(experiment.experiment_date) ?? "No date"}
                    </span>
                    <span className="block text-sm text-ink-3">
                      {format.humanize(experiment.study_type)}
                      {experiment.substrate ? `, ${experiment.substrate}` : ""}
                      {experiment.n_measurements ? `, ${format.count(experiment.n_measurements, "measurement")}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <ExperimentStatusBadge status={experiment.status} />
                  </TableCell>
                  <TableCell className="hidden text-right align-top sm:table-cell">
                    {format.date(experiment.experiment_date) ?? "No date"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function LotAlerts({ alerts }: { alerts: Schemas["LotAlert"][] }) {
  return (
    <section aria-labelledby="alerts-heading" className="lg:col-span-5">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="alerts-heading" className="text-lg font-bold">
          Lot alerts
        </h2>
        <Link to="/inventory" className="text-sm font-bold text-ballpoint underline-offset-2 hover:underline">
          Inventory
        </Link>
      </div>
      {alerts.length === 0 ? (
        <EmptyState title="No lot alerts">Every reagent and tissue lot is in date and in stock.</EmptyState>
      ) : (
        <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
          {alerts.map((alert) => (
            <li key={`${alert.kind}-${alert.id}`} className="px-4 py-3.5" data-testid={`lot-alert-${alert.lot_number}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link
                  to={alert.kind === "tissue" ? `/inventory/tissue-lots/${alert.id}` : "/inventory/reagents"}
                  className="font-bold text-ink underline-offset-2 hover:underline"
                >
                  {alert.name}
                </Link>
                <span className="text-[0.9375rem] font-bold tracking-wide">{alert.lot_number}</span>
              </div>
              <div className="mt-2">
                <LotFlagBadges lot={alert} />
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-ink-3">Expiry</dt>
                <dd className="tabular-nums">
                  {format.date(alert.expiry_date) ?? "Not recorded"}
                  {alert.days_to_expiry !== null ? (
                    <span className="text-ink-3">, {format.daysLeft(alert.days_to_expiry)}</span>
                  ) : null}
                </dd>
                <dt className="text-ink-3">Remaining</dt>
                <dd className="flex items-center gap-2 tabular-nums">
                  {format.quantity(alert.quantity_remaining, alert.quantity_unit) ?? "Not recorded"}
                  {alert.percent_remaining !== null ? (
                    <>
                      <span className="text-ink-3">({format.plain(alert.percent_remaining)}%)</span>
                      <Meter
                        percent={alert.percent_remaining}
                        tone={alert.flags.includes("depleted") ? "empty" : alert.flags.includes("low_stock") ? "low" : "normal"}
                      />
                    </>
                  ) : null}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
