import { CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 py-10 text-ink-3", className)}>
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title,
  error,
  onRetry,
  className,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex items-start gap-3 rounded-lg border border-critical-line bg-critical-bg px-4 py-3", className)}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-critical-fg" />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-critical-fg">{title}</p>
        <p className="text-sm text-ink">{errorMessage(error)}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw aria-hidden />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule-strong bg-surface px-5 py-8 text-center">
      <p className="font-bold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-prose text-sm text-ink-2">{children}</div> : null}
    </div>
  );
}

/** Remaining stock as a bar; the fill carries severity, the track is a lighter step of the same hue. */
export function Meter({ percent, tone }: { percent: number; tone: "normal" | "low" | "empty" }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fill = { normal: "bg-[#3d8fcf]", low: "bg-[#d0632b]", empty: "bg-[#c23a3a]" }[tone];
  const track = { normal: "bg-[#e3eef8]", low: "bg-[#f8e0d2]", empty: "bg-[#f6dada]" }[tone];
  return (
    <span aria-hidden className={cn("block h-1.5 w-16 overflow-hidden rounded-full", track)}>
      <span className={cn("block h-full rounded-full", fill)} style={{ width: `${clamped}%` }} />
    </span>
  );
}
