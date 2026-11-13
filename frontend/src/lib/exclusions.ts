import type { Schemas } from "@/api/client";
import { parseReason, type ExclusionReason } from "./domain";

/** Excluded measurement ids and why. A null reason marks an exclusion whose reason is still to be chosen. */
export type ExclusionDraft = ReadonlyMap<number, ExclusionReason | null>;

export function draftFromResult(result: Schemas["DepletionResult"]): ExclusionDraft {
  return new Map(
    result.arms.flatMap((arm) =>
      arm.points
        .filter((point) => point.excluded)
        .map((point) => [point.measurement_id, parseReason(point.exclusion_reason)] as const),
    ),
  );
}

export function exclude(draft: ExclusionDraft, measurementId: number, reason: ExclusionReason | null): ExclusionDraft {
  return new Map(draft).set(measurementId, reason);
}

export function include(draft: ExclusionDraft, measurementId: number): ExclusionDraft {
  const next = new Map(draft);
  next.delete(measurementId);
  return next;
}

export function excludedIds(draft: ExclusionDraft): number[] {
  return [...draft.keys()].sort((a, b) => a - b);
}

export function sameDraft(a: ExclusionDraft, b: ExclusionDraft): boolean {
  if (a.size !== b.size) return false;
  for (const [measurementId, reason] of a) {
    if (!b.has(measurementId) || b.get(measurementId) !== reason) return false;
  }
  return true;
}

export type SaveReadiness =
  | { kind: "ready"; exclusions: Schemas["Exclusion"][] }
  | { kind: "missing-reasons"; measurementIds: number[] };

export function saveReadiness(draft: ExclusionDraft): SaveReadiness {
  const exclusions: Schemas["Exclusion"][] = [];
  const missing: number[] = [];
  for (const [measurement_id, reason] of draft) {
    if (reason === null) missing.push(measurement_id);
    else exclusions.push({ measurement_id, reason });
  }
  return missing.length > 0 ? { kind: "missing-reasons", measurementIds: missing } : { kind: "ready", exclusions };
}
