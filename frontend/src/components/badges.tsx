import { CircleCheck, CircleX, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ARM_KIND_LABEL, experimentStatus, LOT_FLAG, TONE_CLASS, type ArmKind, type LotFlag, type Tone } from "@/lib/domain";

export function ToneBadge({
  tone,
  icon: Icon,
  children,
  className,
  title,
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[0.8125rem] leading-none font-bold whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} /> : null}
      {children}
    </span>
  );
}

export function ExperimentStatusBadge({ status }: { status: string }) {
  const meta = experimentStatus(status);
  return (
    <ToneBadge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </ToneBadge>
  );
}

const KIND_CLASS: Record<ArmKind, string> = {
  control: "border-neutral-line bg-neutral-bg text-neutral-fg",
  negative_control: "border-dotted border-ink-3 bg-surface text-ink-2",
  inhibitor: "border-rule-strong bg-surface text-ink-2",
  selectivity_control: "border-dashed border-ink-3 bg-surface text-ink-2",
};

export function ArmKindBadge({ kind }: { kind: ArmKind }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md border px-1.5 text-[0.8125rem] leading-none font-bold whitespace-nowrap",
        KIND_CLASS[kind],
      )}
    >
      {ARM_KIND_LABEL[kind]}
    </span>
  );
}

export function LotFlagBadges({
  lot,
}: {
  lot: { flags: readonly LotFlag[]; days_to_expiry: number | null; percent_remaining?: number | null };
}) {
  if (lot.flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {lot.flags.map((flag) => {
        const meta = LOT_FLAG[flag];
        return (
          <ToneBadge key={flag} tone={meta.tone} icon={meta.icon}>
            {meta.label(lot)}
          </ToneBadge>
        );
      })}
    </span>
  );
}

/** Whether the lot was within its expiry on the experiment date; null when either date is unknown. */
export function ValidAtUseBadge({ valid }: { valid: boolean | null | undefined }) {
  if (valid === null || valid === undefined) {
    return <span className="text-sm text-ink-3">Validity at use unknown</span>;
  }
  return valid ? (
    <ToneBadge tone="good" icon={CircleCheck} title="Within expiry on the experiment date">
      Valid at use
    </ToneBadge>
  ) : (
    <ToneBadge tone="critical" icon={CircleX} title="Past expiry on the experiment date">
      Expired at use
    </ToneBadge>
  );
}
