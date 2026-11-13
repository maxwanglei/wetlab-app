import { useQuery } from "@tanstack/react-query";
import { CircleCheck, Pencil, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router";
import type { Schemas } from "@/api/client";
import { queries } from "@/api/queries";
import { LotFlagBadges } from "@/components/badges";
import { EmptyState, ErrorState, Loading, Meter } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { readFlash } from "@/lib/flash";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";

const TABS = [
  { slug: "reagents", label: "Reagent lots" },
  { slug: "tissue", label: "Tissue lots" },
] as const;

export function InventoryPage() {
  const { tab } = useParams();
  const active = TABS.find((item) => item.slug === tab)?.slug;
  if (!active) return <Navigate to="/inventory/reagents" replace />;
  return (
    <div className="space-y-6">
      <h1 className="text-[1.75rem] leading-tight font-bold">Inventory</h1>
      <nav aria-label="Inventory sections" className="flex gap-1 border-b border-rule">
        {TABS.map((item) => (
          <NavLink
            key={item.slug}
            to={`/inventory/${item.slug}`}
            className={({ isActive }) =>
              cn(
                "-mb-px rounded-t-md px-4 py-2.5 text-[0.9375rem] font-bold text-ink-2 hover:text-ink",
                isActive && "border-x border-t border-rule bg-surface text-ink",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      {active === "reagents" ? <ReagentLots /> : <TissueLots />}
    </div>
  );
}

function Expiry({ date, days }: { date: string | null; days: number | null }) {
  if (!date) return <span className="text-ink-3">No expiry</span>;
  return (
    <>
      {format.date(date)}
      {days !== null ? (
        <span className={cn("block text-sm", days < 0 ? "font-bold text-critical-fg" : days <= 30 ? "font-bold text-warning-fg" : "text-ink-3")}>
          {format.daysLeft(days)}
        </span>
      ) : null}
    </>
  );
}

function meterTone(lot: { flags: readonly string[] }) {
  if (lot.flags.includes("depleted")) return "empty";
  return lot.flags.includes("low_stock") ? "low" : "normal";
}

function AddTissueLotButton() {
  return (
    <Button asChild className="px-3 font-bold">
      <Link to="/inventory/tissue-lots/new">
        <Plus aria-hidden />
        Add tissue lot
      </Link>
    </Button>
  );
}

function AddLotButton() {
  return (
    <Button asChild className="px-3 font-bold">
      <Link to="/inventory/reagent-lots/new">
        <Plus aria-hidden />
        Add lot
      </Link>
    </Button>
  );
}

/** The lot a form just saved, with what happened to it, from the navigation that brought us here. */
function useSavedLot() {
  const flash = readFlash(useLocation().state);
  return flash?.kind === "lot-saved" ? flash : null;
}

function ReagentLots() {
  const lots = useQuery(queries.reagentLots());
  const saved = useSavedLot();
  const savedRow = useRef<HTMLTableRowElement>(null);
  const savedLot = saved ? lots.data?.find((lot) => lot.id === saved.lotId) : undefined;

  useEffect(() => {
    savedRow.current?.scrollIntoView({ block: "nearest" });
  }, [savedLot?.id]);

  if (lots.isPending) return <Loading label="Loading reagent lots…" />;
  if (lots.isError) return <ErrorState title="Reagent lots could not load" error={lots.error} onRetry={() => lots.refetch()} />;
  if (lots.data.length === 0) {
    return (
      <EmptyState title="No reagent lots recorded">
        <p>Add the first lot when it arrives.</p>
        <div className="mt-3">
          <AddLotButton />
        </div>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="flex items-center gap-2 font-bold text-good-fg">
          {saved && savedLot ? (
            <>
              <CircleCheck aria-hidden className="size-5" />
              {saved.action === "added" ? "Added" : "Saved"} lot {savedLot.lot_number} of {savedLot.reagent}.
            </>
          ) : null}
        </p>
        <AddLotButton />
      </div>
      <div className="rounded-lg border border-rule bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Reagent</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Lot</TableHead>
              <TableHead className="text-right">Concentration</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">Storage</TableHead>
              <TableHead>Remaining</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead className="pr-5">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.data.map((lot: Schemas["ReagentLotRow"]) => {
              const isSaved = lot.id === savedLot?.id;
              return (
                <TableRow
                  key={lot.id}
                  ref={isSaved ? savedRow : undefined}
                  data-testid={`reagent-lot-${lot.lot_number}`}
                  data-just-saved={isSaved || undefined}
                  className={cn(isSaved && "bg-[color-mix(in_oklch,var(--tape)_22%,white)] hover:bg-[color-mix(in_oklch,var(--tape)_30%,white)]")}
                >
                  <TableCell className={cn("pl-5 whitespace-normal", isSaved && "shadow-[inset_4px_0_0_var(--tape)]")}>
                    <span className="font-bold">{lot.reagent}</span>
                    {lot.notes ? <span className="block text-sm text-ink-3">{lot.notes}</span> : null}
                  </TableCell>
                  <TableCell>{lot.reagent_type ? format.humanize(lot.reagent_type) : <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell>
                    <span className="font-bold tracking-wide">{lot.lot_number}</span>
                    {lot.vendor || lot.catalog_number ? (
                      <span className="block text-sm text-ink-3">
                        {[lot.vendor, lot.catalog_number ? `Cat. ${lot.catalog_number}` : null].filter(Boolean).join(", ")}
                      </span>
                    ) : null}
                    {isSaved && saved ? (
                      <span className="block text-sm font-bold text-ink-2">{saved.action === "added" ? "Just added" : "Just saved"}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {format.quantity(lot.concentration, lot.concentration_unit) ?? <span className="text-ink-3">–</span>}
                  </TableCell>
                  <TableCell>{format.date(lot.received_date) ?? <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell>
                    <Expiry date={lot.expiry_date} days={lot.days_to_expiry} />
                  </TableCell>
                  <TableCell className="text-right">{format.temperature(lot.storage_temp_c) ?? <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell>
                    {lot.quantity_remaining !== null ? (
                      <span className="flex items-center gap-3">
                        <span className="min-w-[8.5rem]">
                          {format.plain(lot.quantity_remaining)}
                          {lot.quantity_received !== null ? ` of ${format.plain(lot.quantity_received)}` : ""} {format.unit(lot.quantity_unit)}
                          {lot.percent_remaining !== null ? (
                            <span className="block text-sm text-ink-3">{format.plain(lot.percent_remaining)}% left</span>
                          ) : null}
                        </span>
                        {lot.percent_remaining !== null ? <Meter percent={lot.percent_remaining} tone={meterTone(lot)} /> : null}
                      </span>
                    ) : (
                      <span className="text-ink-3">Not recorded</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {lot.flags.length > 0 ? <LotFlagBadges lot={lot} /> : <span className="text-sm text-ink-3">None</span>}
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <Button asChild variant="ghost" size="sm" className="text-ballpoint">
                      <Link to={`/inventory/reagent-lots/${lot.id}/edit`} aria-label={`Edit lot ${lot.lot_number}`}>
                        <Pencil aria-hidden />
                        Edit
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TissueLots() {
  const lots = useQuery(queries.tissueLots());
  const navigate = useNavigate();
  const saved = useSavedLot();
  const savedRow = useRef<HTMLTableRowElement>(null);
  const savedLot = saved ? lots.data?.find((lot) => lot.id === saved.lotId) : undefined;

  useEffect(() => {
    savedRow.current?.scrollIntoView({ block: "nearest" });
  }, [savedLot?.id]);

  if (lots.isPending) return <Loading label="Loading tissue lots…" />;
  if (lots.isError) return <ErrorState title="Tissue lots could not load" error={lots.error} onRetry={() => lots.refetch()} />;
  if (lots.data.length === 0) {
    return (
      <EmptyState title="No tissue lots recorded">
        <p>Add the first lot when it arrives.</p>
        <div className="mt-3">
          <AddTissueLotButton />
        </div>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="flex items-center gap-2 font-bold text-good-fg">
          {saved && savedLot ? (
            <>
              <CircleCheck aria-hidden className="size-5" />
              Added lot {savedLot.lot_number}.
            </>
          ) : null}
        </p>
        <AddTissueLotButton />
      </div>
      <div className="rounded-lg border border-rule bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Lot</TableHead>
              <TableHead>Material</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Donors</TableHead>
              <TableHead className="text-right">Protein or viability</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">Storage</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="pr-5">Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.data.map((lot) => {
              const href = `/inventory/tissue-lots/${lot.id}`;
              const isSaved = lot.id === savedLot?.id;
              return (
                <TableRow
                  key={lot.id}
                  ref={isSaved ? savedRow : undefined}
                  data-testid={`tissue-lot-${lot.lot_number}`}
                  data-just-saved={isSaved || undefined}
                  className={cn(
                    "cursor-pointer",
                    isSaved && "bg-[color-mix(in_oklch,var(--tape)_22%,white)] hover:bg-[color-mix(in_oklch,var(--tape)_30%,white)]",
                  )}
                  onClick={() => navigate(href)}
                >
                  <TableCell className={cn("pl-5", isSaved && "shadow-[inset_4px_0_0_var(--tape)]")}>
                    <Link
                      to={href}
                      onClick={(event) => event.stopPropagation()}
                      className="font-bold tracking-wide text-ballpoint underline-offset-2 hover:underline"
                    >
                      {lot.lot_number ?? `Lot ${lot.id}`}
                    </Link>
                    {isSaved ? <span className="block text-sm font-bold text-ink-2">Just added</span> : null}
                  </TableCell>
                  <TableCell>
                    {lot.material_type ? format.humanize(lot.material_type) : "Not recorded"}
                    {lot.species ? <span className="block text-sm text-ink-3">{format.humanize(lot.species)}</span> : null}
                  </TableCell>
                  <TableCell>{lot.vendor_or_source ?? <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell>
                    {lot.pooled_or_individual ? format.humanize(lot.pooled_or_individual) : "–"}
                    {lot.number_of_donors !== null ? (
                      <span className="block text-sm text-ink-3">{format.count(lot.number_of_donors, "donor")}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {lot.protein_concentration !== null
                      ? format.quantity(lot.protein_concentration, lot.protein_concentration_unit)
                      : lot.viability !== null
                        ? `${format.plain(lot.viability)}% viable`
                        : <span className="text-ink-3">–</span>}
                  </TableCell>
                  <TableCell>{format.date(lot.received_date) ?? <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell>
                    <Expiry date={lot.expiry_date} days={lot.days_to_expiry} />
                  </TableCell>
                  <TableCell className="text-right">{format.temperature(lot.storage_temp_c) ?? <span className="text-ink-3">–</span>}</TableCell>
                  <TableCell className="text-right">
                    {format.quantity(lot.quantity_remaining, lot.quantity_unit) ?? <span className="text-ink-3">–</span>}
                  </TableCell>
                  <TableCell className="pr-5">
                    {lot.flags.length > 0 ? <LotFlagBadges lot={lot} /> : <span className="text-sm text-ink-3">None</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
