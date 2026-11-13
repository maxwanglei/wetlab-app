/** Route ids are positive integers; anything else is a link that can never resolve. */
export function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}
