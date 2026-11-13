import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, ClipboardPaste, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { errorMessage, type Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { NumberWithUnit, Select } from "@/components/form";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { benchGrid } from "@/lib/bench-grid";
import { SUBSTRATE_CONCENTRATION_UNITS, unitChoices, type ArmStyle } from "@/lib/domain";
import { draftReader } from "@/lib/drafts";
import * as format from "@/lib/format";
import { WideGrid } from "./WideGrid";

type ValueKind = NonNullable<Schemas["PastePreviewRequest"]["value_kind"]>;
type PasteInput = { text: string; valueKind: ValueKind };
type Preview = { input: PasteInput; result: Schemas["PastePreview"] };
type CopyStatus = { kind: "idle" } | { kind: "copied"; what: string } | { kind: "failed" };

/** Copies a block to the clipboard, keeping whether it worked to say so. */
export function useCopy() {
  const [status, setStatus] = useState<CopyStatus>({ kind: "idle" });
  async function copy(content: string, what: string) {
    try {
      await navigator.clipboard.writeText(content);
      setStatus({ kind: "copied", what });
    } catch {
      setStatus({ kind: "failed" });
    }
  }
  return { status, copy };
}

export function CopyStatusLine({ status, columns }: { status: CopyStatus; columns: readonly string[] }) {
  return (
    <p aria-live="polite" className="text-sm">
      {status.kind === "copied" ? (
        <span className="inline-flex items-center gap-1 text-good-fg">
          <CircleCheck aria-hidden className="size-4" />
          {status.what} copied. Paste it into Excel; columns are tab-separated.
        </span>
      ) : status.kind === "failed" ? (
        <span className="text-critical-fg">The browser blocked the clipboard. Template columns: {columns.join(", ")}.</span>
      ) : (
        <span className="text-ink-3">{format.count(columns.length, "column")} in the template.</span>
      )}
    </p>
  );
}

/** The substrate concentration typed for a paste, as its text and unit. */
export function SubstrateField({
  text,
  unit,
  onText,
  onUnit,
}: {
  text: string;
  unit: string;
  onText: (text: string) => void;
  onUnit: (unit: string) => void;
}) {
  return (
    <div>
      <label htmlFor="substrate-concentration" className="text-sm font-bold text-ink-2">
        Substrate concentration
        <span aria-hidden className="ml-0.5 text-critical-fg">
          *
        </span>
      </label>
      <div className="mt-1">
        <NumberWithUnit
          id="substrate-concentration"
          aria-required
          aria-describedby="substrate-concentration-hint"
          value={text}
          onChange={(event) => onText(event.target.value)}
          unitValue={unit}
          units={unitChoices(SUBSTRATE_CONCENTRATION_UNITS, unit)}
          onUnitChange={onUnit}
          unitLabel="Substrate concentration unit"
        />
      </div>
      <p id="substrate-concentration-hint" className="mt-1.5 text-sm text-ink-3">
        In the incubation. Saved with every value.
      </p>
    </div>
  );
}

export function PreviewProblems({ result }: { result: Schemas["PastePreview"] }) {
  return (
    <>
      {result.errors.length > 0 ? (
        <div role="alert" className="rounded-lg border border-critical-line bg-critical-bg px-4 py-3">
          <p className="flex items-center gap-2 font-bold text-critical-fg">
            <CircleAlert aria-hidden className="size-4" />
            Fix {result.errors.length === 1 ? "this problem" : "these problems"} before saving
          </p>
          <ul className="mt-1 list-disc pl-6 text-sm text-ink">
            {result.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.warnings.length > 0 ? (
        <div className="rounded-lg border border-warning-line bg-warning-bg px-4 py-3">
          <p className="flex items-center gap-2 font-bold text-warning-fg">
            <TriangleAlert aria-hidden className="size-4" />
            Check {result.warnings.length === 1 ? "this" : "these"}
          </p>
          <ul className="mt-1 list-disc pl-6 text-sm text-ink">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

const VALUE_KINDS: { value: ValueKind; label: string }[] = [
  { value: "percent_of_t0", label: "% of T0" },
  { value: "area_ratio", label: "Area ratio" },
];

function isValueKind(value: string): value is ValueKind {
  return VALUE_KINDS.some((kind) => kind.value === value);
}

function savedValuesBlock(measurements: Schemas["Measurements"]): string {
  const grid = benchGrid(measurements.arms, measurements.rows);
  const lines = grid.timepoints.map((timepoint) =>
    [
      String(timepoint),
      ...grid.arms.flatMap((arm) =>
        grid.replicates.map((replicate) => {
          const value = grid.cell(timepoint, arm.key, replicate)?.percent_of_t0;
          return value === null || value === undefined ? "" : String(value);
        }),
      ),
    ].join("\t"),
  );
  return [measurements.template_columns.join("\t"), ...lines].join("\n") + "\n";
}

/** The substrate concentration saved with every pasted value; null until a positive number is typed. */
export function substrateConcentration(text: string): number | null {
  const value = draftReader().number("substrate_concentration", text);
  return value !== null && value > 0 ? value : null;
}

function parsedCell(row: Schemas["ParsedMeasurement"] | undefined) {
  if (!row) return { content: <span className="text-ink-3">–</span>, title: "No value pasted" };
  return {
    content: row.percent_of_t0 === null || row.percent_of_t0 === undefined ? "–" : format.fixed(row.percent_of_t0, 2),
    title: row.raw_value !== null && row.raw_value !== undefined ? `Area ratio ${format.plain(row.raw_value)}` : undefined,
  };
}

export function PastePanel({
  experiment,
  measurements,
  styles,
  onReplaced,
  onDraftChange,
}: {
  experiment: Schemas["ExperimentDetail"];
  measurements: Schemas["Measurements"];
  styles: ReadonlyMap<string, ArmStyle>;
  onReplaced: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [valueKind, setValueKind] = useState<ValueKind>("percent_of_t0");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const clipboard = useCopy();
  const [replacedCount, setReplacedCount] = useState<number | null>(null);
  const [substrateText, setSubstrateText] = useState(() => {
    const saved = experiment.substrate_concentrations[0];
    return saved ? String(saved.value) : "";
  });
  const [substrateUnit, setSubstrateUnit] = useState(() => experiment.substrate_concentrations[0]?.unit ?? "uM");
  const staged = experiment.stages.length > 1;
  const [stage, setStage] = useState(() => measurements.stage ?? experiment.stages.at(-1)?.stage_type ?? null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const requestPreview = useMutation({
    mutationFn: (input: PasteInput) =>
      mutations.pastePreview(experiment.id, { text: input.text, value_kind: input.valueKind }),
    onSuccess: (result, input) => {
      setPreview({ input, result });
      setConfirming(false);
    },
  });

  const replace = useMutation({
    mutationFn: (body: Schemas["ReplaceMeasurements"]) => mutations.replaceMeasurements(experiment.id, body),
    onSuccess: async (saved, body) => {
      queryClient.setQueryData(queries.measurements(experiment.id).queryKey, saved);
      queryClient.removeQueries({ queryKey: ["experiments", experiment.id, "depletion", "preview"] });
      onReplaced();
      setReplacedCount(body.rows.length);
      setText("");
      if (body.substrate_concentration !== null && body.substrate_concentration !== undefined) {
        setSubstrateText(String(body.substrate_concentration));
      }
      setSubstrateUnit(body.substrate_concentration_unit ?? "uM");
      setPreview(null);
      setConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["experiments", experiment.id] }),
        queryClient.invalidateQueries({ queryKey: ["experiments"], exact: true }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const previewIsCurrent = preview !== null && preview.input.text === text && preview.input.valueKind === valueKind;
  const substrate = substrateConcentration(substrateText);
  const substrateMissing = substrate === null;
  const canSave = previewIsCurrent && preview.result.errors.length === 0 && preview.result.rows.length > 0 && !substrateMissing;
  const existing = measurements.rows.length;
  const dirty = text !== "" || substrateText !== (experiment.substrate_concentrations[0] ? String(experiment.substrate_concentrations[0].value) : "") ||
    substrateUnit !== (experiment.substrate_concentrations[0]?.unit ?? "uM") ||
    stage !== (measurements.stage ?? experiment.stages.at(-1)?.stage_type ?? null);
  useEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);

  return (
    <section aria-labelledby="paste-heading" className="rounded-lg border border-rule bg-surface p-5">
      <fieldset disabled={replace.isPending} className="min-w-0">
      <h2 id="paste-heading" className="text-lg font-bold">
        Paste from Excel
      </h2>
      <p className="mt-1 max-w-[72ch] text-ink-2">
        Paste one row per timepoint: the time in minutes first, then one column per arm and replicate, in the
        template's order. A header row is optional.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => clipboard.copy(measurements.template_columns.join("\t") + "\n", "Template")}>
          <Copy aria-hidden />
          Copy template
        </Button>
        {existing > 0 ? (
          <Button variant="ghost" onClick={() => clipboard.copy(savedValuesBlock(measurements), "Saved values")}>
            <Copy aria-hidden />
            Copy saved values
          </Button>
        ) : null}
        <CopyStatusLine status={clipboard.status} columns={measurements.template_columns} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          <label htmlFor="paste-block" className="text-sm font-bold text-ink-2">
            Pasted block
          </label>
          <Textarea
            id="paste-block"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setReplacedCount(null);
            }}
            rows={8}
            wrap="off"
            spellCheck={false}
            placeholder={`${measurements.template_columns.slice(0, 3).join("    ")}    …`}
            className="mt-1 min-h-40 w-full font-mono text-sm"
          />
        </div>
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="text-sm font-bold text-ink-2">Values are</legend>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={valueKind}
              onValueChange={(value) => {
                if (isValueKind(value)) setValueKind(value);
              }}
              className="mt-1"
            >
              {VALUE_KINDS.map((kind) => (
                <ToggleGroupItem key={kind.value} value={kind.value} className="px-3 font-bold data-[state=on]:bg-ink data-[state=on]:text-white">
                  {kind.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="mt-1.5 text-sm text-ink-3">
              {valueKind === "area_ratio"
                ? "Area ratios are converted to % of each replicate's own T0."
                : "Each replicate's T0 should read 100."}
            </p>
          </fieldset>
          <SubstrateField text={substrateText} unit={substrateUnit} onText={setSubstrateText} onUnit={setSubstrateUnit} />
          {staged ? (
            <div>
              <label htmlFor="paste-stage" className="text-sm font-bold text-ink-2">
                Sampled from
              </label>
              <div className="mt-1">
                <Select
                  id="paste-stage"
                  aria-describedby="paste-stage-hint"
                  value={stage ?? ""}
                  onChange={(event) => {
                    const chosen = experiment.stages.find((candidate) => candidate.stage_type === event.target.value);
                    if (chosen) setStage(chosen.stage_type);
                  }}
                >
                  {experiment.stages.map((candidate) => (
                    <option key={candidate.id} value={candidate.stage_type}>
                      {format.humanize(candidate.stage_type)} stage
                    </option>
                  ))}
                </Select>
              </div>
              <p id="paste-stage-hint" className="mt-1.5 text-sm text-ink-3">
                Its protein scales CLint.
              </p>
            </div>
          ) : null}
          <Button
            onClick={() => requestPreview.mutate({ text, valueKind })}
            disabled={text.trim() === "" || requestPreview.isPending}
          >
            <ClipboardPaste aria-hidden />
            {requestPreview.isPending ? "Reading…" : "Preview"}
          </Button>
        </div>
      </div>

      {requestPreview.isError ? (
        <ErrorState className="mt-5" title="The preview failed" error={requestPreview.error} />
      ) : null}

      {replacedCount !== null ? (
        <p role="status" className="mt-5 flex items-center gap-2 font-bold text-good-fg">
          <CircleCheck aria-hidden className="size-5" />
          Saved {format.count(replacedCount, "measurement")}.{" "}
          <Link to={`/experiments/${experiment.id}/results`} className="text-ballpoint underline underline-offset-2">
            See the new fits on the Results tab
          </Link>
        </p>
      ) : null}

      {preview ? (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h3 className="text-base font-bold">Preview</h3>
            <p className="text-sm text-ink-2">
              {format.count(preview.result.rows.length, "value")} read as{" "}
              {VALUE_KINDS.find((kind) => kind.value === preview.input.valueKind)?.label}.
            </p>
          </div>
          {!previewIsCurrent ? (
            <p className="flex items-center gap-2 text-sm font-bold text-warning-fg">
              <TriangleAlert aria-hidden className="size-4" />
              The pasted block or value type changed since this preview. Preview again before saving.
            </p>
          ) : null}
          <PreviewProblems result={preview.result} />
          {preview.result.rows.length > 0 ? (
            <WideGrid
              grid={benchGrid(measurements.arms, preview.result.rows)}
              styles={styles}
              renderCell={parsedCell}
              caption="Pasted values as % of T0, by timepoint, arm and replicate"
            />
          ) : null}

          {confirming ? (
            <div
              role="group"
              aria-labelledby="replace-heading"
              className="rounded-lg border border-warning-line bg-warning-bg px-4 py-4"
            >
              <p id="replace-heading" className="font-bold text-ink">
                {existing > 0
                  ? `Replace ${format.count(existing, "saved measurement")} with ${format.count(preview.result.rows.length, "pasted value")} at ${format.quantity(substrate, substrateUnit)} substrate?`
                  : `Save ${format.count(preview.result.rows.length, "pasted value")} at ${format.quantity(substrate, substrateUnit)} substrate?`}
              </p>
              <p className="mt-1 max-w-[72ch] text-ink-2">
                {existing > 0
                  ? `This replaces all ${existing} rows for ${experiment.code ?? "this experiment"} and clears their exclusions and any saved results. It cannot be undone.`
                  : "There are no saved measurements to replace. Any saved results are cleared."}
              </p>
              {replace.isError ? <p className="mt-2 text-sm font-bold text-critical-fg">{errorMessage(replace.error)}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  ref={confirmButton}
                  variant="destructive"
                  disabled={replace.isPending || !canSave}
                  onClick={() => {
                    if (!canSave || substrate === null) return;
                    replace.mutate({
                      rows: preview.result.rows,
                      value_kind: preview.input.valueKind,
                      substrate_concentration: substrate,
                      substrate_concentration_unit: substrateUnit,
                      ...(staged && stage !== null ? { stage } : {}),
                    });
                  }}
                >
                  {replace.isPending ? "Saving…" : existing > 0 ? "Replace measurements" : "Save measurements"}
                </Button>
                <Button variant="outline" onClick={() => setConfirming(false)} disabled={replace.isPending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setConfirming(true)} disabled={!canSave}>
                Save measurements
              </Button>
              {substrateMissing ? (
                <p className="text-sm font-bold text-warning-fg">Enter the substrate concentration above to save.</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      </fieldset>
    </section>
  );
}
