import { useQuery } from "@tanstack/react-query";
import { CircleCheck, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError, type Schemas } from "@/api/client";
import { queries } from "@/api/queries";
import { NotFound } from "@/components/AppShell";
import { ExperimentStatusBadge, LotFlagBadges } from "@/components/badges";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as format from "@/lib/format";
import { parseId } from "@/lib/params";

function ageText(donor: Schemas["Donor"]): string | null {
  if (donor.age_min === null && donor.age_max === null) return null;
  if (donor.age_min !== null && donor.age_max !== null && donor.age_min !== donor.age_max) {
    return `${format.plain(donor.age_min)}–${format.plain(donor.age_max)}`;
  }
  return format.plain(donor.age_min ?? donor.age_max ?? 0);
}

function range(values: number[]): string | null {
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? format.plain(low) : `${format.plain(low)}–${format.plain(high)}`;
}

function donorSummary(donors: Schemas["Donor"][]): string | null {
  if (donors.length === 0) return null;
  const sexes = new Map<string, number>();
  for (const donor of donors) {
    if (donor.sex) sexes.set(donor.sex, (sexes.get(donor.sex) ?? 0) + 1);
  }
  const parts = [...sexes].map(([sex, count]) => `${count} ${sex}`);
  const ages = range(donors.flatMap((donor) => [donor.age_min, donor.age_max]).filter((age) => age !== null));
  const bmis = range(donors.map((donor) => donor.bmi).filter((bmi) => bmi !== null));
  if (ages) parts.push(`age ${ages}`);
  if (bmis) parts.push(`BMI ${bmis}`);
  return parts.join(", ");
}

export function TissueLotPage() {
  const lotId = parseId(useParams().lotId);
  const lot = useQuery({ ...queries.tissueLot(lotId ?? 0), enabled: lotId !== null });
  if (lotId === null) return <NotFound what="tissue lot" />;
  if (lot.isPending) return <Loading label="Loading the tissue lot…" />;
  if (lot.isError) {
    if (lot.error instanceof ApiError && lot.error.status === 404) return <NotFound what="tissue lot" />;
    return <ErrorState title="This tissue lot could not load" error={lot.error} onRetry={() => lot.refetch()} />;
  }
  const detail = lot.data;
  const facts: [string, ReactNode][] = [
    ["Material", detail.material_type ? format.humanize(detail.material_type) : null],
    ["Species", detail.species ? format.humanize(detail.species) : null],
    ["Source", detail.vendor_or_source],
    ["Catalog number", detail.catalog_number],
    [
      "Donors",
      detail.pooled_or_individual
        ? `${format.humanize(detail.pooled_or_individual)}${detail.number_of_donors !== null ? `, ${format.count(detail.number_of_donors, "donor")}` : ""}`
        : null,
    ],
    ["Protein", format.quantity(detail.protein_concentration, detail.protein_concentration_unit)],
    ["Viability", detail.viability !== null ? `${format.plain(detail.viability)}%` : null],
    ["Received", format.date(detail.received_date)],
    [
      "Expiry",
      detail.expiry_date ? (
        <>
          {format.date(detail.expiry_date)}
          {detail.days_to_expiry !== null ? <span className="text-ink-3">, {format.daysLeft(detail.days_to_expiry)}</span> : null}
        </>
      ) : null,
    ],
    ["Storage", format.temperature(detail.storage_temp_c)],
    ["Remaining", format.quantity(detail.quantity_remaining, detail.quantity_unit)],
  ];
  const summary = donorSummary(detail.donors);

  return (
    <div className="space-y-8">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
          <Link to="/inventory/tissue" className="font-bold text-ballpoint underline-offset-2 hover:underline">
            Tissue lots
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span aria-current="page">{detail.lot_number ?? `Lot ${detail.id}`}</span>
        </nav>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-[1.75rem] leading-tight font-bold tracking-wide">{detail.lot_number ?? `Lot ${detail.id}`}</h1>
          <LotFlagBadges lot={detail} />
          <Button asChild variant="outline" className="ml-auto font-bold">
            <Link to={`/inventory/tissue-lots/${detail.id}/edit`}><Pencil aria-hidden />Update stock</Link>
          </Button>
        </div>
        <p className="mt-1 text-ink-2">
          {format.humanize(
            `${[detail.species, detail.material_type].filter(Boolean).join(" ") || "Tissue lot"}${
              detail.vendor_or_source ? ` from ${detail.vendor_or_source}` : ""
            }`,
          )}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-12">
        <section aria-labelledby="lot-facts" className="lg:col-span-4">
          <h2 id="lot-facts" className="mb-3 text-lg font-bold">
            Lot
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 rounded-lg border border-rule bg-surface p-5 text-[0.9375rem] tabular-nums">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-3">{label}</dt>
                <dd>{value ?? <span className="text-ink-3">Not recorded</span>}</dd>
              </div>
            ))}
          </dl>
          {detail.notes ? <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">{detail.notes}</p> : null}
        </section>

        <section aria-labelledby="donors-heading" className="lg:col-span-8">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6">
            <h2 id="donors-heading" className="text-lg font-bold">
              Donors
            </h2>
            {summary ? <p className="text-sm text-ink-2">{summary}</p> : null}
          </div>
          {detail.donors.length === 0 ? (
            <EmptyState title="No donor records for this lot" />
          ) : (
            <div className="rounded-lg border border-rule bg-surface">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Donor</TableHead>
                    <TableHead>Sex</TableHead>
                    <TableHead className="text-right">Age (years)</TableHead>
                    <TableHead className="text-right">BMI</TableHead>
                    <TableHead>Disease state</TableHead>
                    <TableHead className="pr-5">Genotype</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.donors.map((donor, index) => (
                    <TableRow key={donor.donor_id_in_source ?? index}>
                      <TableCell className="pl-5 font-bold tracking-wide">{donor.donor_id_in_source ?? `Donor ${index + 1}`}</TableCell>
                      <TableCell>{donor.sex ? format.humanize(donor.sex) : <span className="text-ink-3">–</span>}</TableCell>
                      <TableCell className="text-right">{ageText(donor) ?? <span className="text-ink-3">–</span>}</TableCell>
                      <TableCell className="text-right">
                        {donor.bmi !== null ? format.fixed(donor.bmi, 1) : <span className="text-ink-3">–</span>}
                      </TableCell>
                      <TableCell>{donor.disease_state ? format.humanize(donor.disease_state) : <span className="text-ink-3">–</span>}</TableCell>
                      <TableCell className="pr-5">
                        {donor.genotype_available === true ? (
                          <span className="inline-flex items-center gap-1 text-good-fg">
                            <CircleCheck aria-hidden className="size-4" />
                            Available
                          </span>
                        ) : donor.genotype_available === false ? (
                          <span className="text-ink-3">Not available</span>
                        ) : (
                          <span className="text-ink-3">Unknown</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="used-heading">
        <h2 id="used-heading" className="mb-3 text-lg font-bold">
          Used in
        </h2>
        {detail.used_in.length === 0 ? (
          <EmptyState title="No experiments have used this lot yet" />
        ) : (
          <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
            {detail.used_in.map((experiment) => (
              <li key={experiment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <Link
                  to={`/experiments/${experiment.id}/setup`}
                  className="font-bold text-ballpoint underline-offset-2 hover:underline"
                >
                  {experiment.code ?? `Experiment ${experiment.id}`}
                </Link>
                <span className="min-w-0 flex-1">{experiment.title}</span>
                <ExperimentStatusBadge status={experiment.status} />
                <span className="w-28 text-right tabular-nums text-ink-2">{format.date(experiment.experiment_date) ?? "No date"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
