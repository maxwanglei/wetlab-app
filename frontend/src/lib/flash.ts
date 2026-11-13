/** A note carried in the history entry's state from a form to the page it lands on, so that page can say
 * what just happened without putting it in the URL. It lasts until the next navigation. */
export type Flash =
  | { kind: "lot-saved"; action: "added" | "updated"; lotId: number }
  | { kind: "experiment-planned"; experimentId: number };

export function withFlash(flash: Flash): { flash: Flash } {
  return { flash };
}

/** History state is whatever the last page stored there, so it is read as untrusted. */
export function readFlash(state: unknown): Flash | null {
  if (typeof state !== "object" || state === null || !("flash" in state)) return null;
  const { flash } = state;
  if (typeof flash !== "object" || flash === null || !("kind" in flash)) return null;
  if (flash.kind === "lot-saved" && "lotId" in flash && typeof flash.lotId === "number" && "action" in flash) {
    if (flash.action === "added" || flash.action === "updated") {
      return { kind: "lot-saved", action: flash.action, lotId: flash.lotId };
    }
  }
  if (flash.kind === "experiment-planned" && "experimentId" in flash && typeof flash.experimentId === "number") {
    return { kind: "experiment-planned", experimentId: flash.experimentId };
  }
  return null;
}
