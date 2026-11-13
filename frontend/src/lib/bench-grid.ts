type GridRow = { arm_key: string; replicate: number; timepoint: number };

export type BenchGrid<Row extends GridRow> = {
  arms: { key: string; label: string }[];
  replicates: number[];
  timepoints: number[];
  cell: (timepoint: number, armKey: string, replicate: number) => Row | undefined;
};

/** Wide layout of one experiment's measurements: a row per timepoint, a column per arm and replicate.
 * Saved measurements and a pasted preview share it, so both read the same way. */
export function benchGrid<Row extends GridRow>(
  arms: readonly { key: string; label: string }[],
  rows: readonly Row[],
): BenchGrid<Row> {
  const known = new Set(arms.map((arm) => arm.key));
  const cells = new Map<string, Row>();
  const timepoints = new Set<number>();
  let maxReplicate = 1;
  for (const row of rows) {
    if (!known.has(row.arm_key)) continue;
    cells.set(`${row.timepoint}|${row.arm_key}|${row.replicate}`, row);
    timepoints.add(row.timepoint);
    maxReplicate = Math.max(maxReplicate, row.replicate);
  }
  return {
    arms: arms.map(({ key, label }) => ({ key, label })),
    replicates: Array.from({ length: maxReplicate }, (_, index) => index + 1),
    timepoints: [...timepoints].sort((a, b) => a - b),
    cell: (timepoint, armKey, replicate) => cells.get(`${timepoint}|${armKey}|${replicate}`),
  };
}
