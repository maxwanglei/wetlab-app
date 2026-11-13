import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, ClipboardPaste, Copy, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { ArmSwatch } from "@/components/ArmSwatch";
import { Input, Select } from "@/components/form";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ArmStyle } from "@/lib/domain";
import { sameName } from "@/lib/drafts";
import * as format from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyStatusLine, PreviewProblems, SubstrateField, substrateConcentration, useCopy } from "./PastePanel";

type Measurements = Schemas["Measurements"];
/** What the picker can show: the parent, a metabolite with data, by name, or one being named. */
type Choice = { kind: "parent" } | { kind: "metabolite"; name: string } | { kind: "new" };
type Analyte = { name: string; metabolite: string | null };
type Read = { arm_key: string; replicate: number; raw_value?: number | null };

const NEW_METABOLITE = "new";

function choiceValue(choice: Choice): string {
  return choice.kind === "metabolite" ? `metabolite:${choice.name}` : choice.kind;
}

/** A single endpoint's raw reads, one analyte at a time: the parent or any metabolite, each read once per well at
 * the end of the last stage as an area ratio. */
export function EndpointBenchData({
  experiment,
  styles,
  onDraftChange,
}: {
  experiment: Schemas["ExperimentDetail"];
  styles: ReadonlyMap<string, ArmStyle>;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [choice, setChoice] = useState<Choice>({ kind: "parent" });
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<Choice | null>(null);
  const reportDraft = useCallback((dirty: boolean) => {
    setDraftDirty(dirty);
    onDraftChange(dirty);
  }, [onDraftChange]);
  const requestedMetabolite = choice.kind === "metabolite" ? choice.name : choice.kind === "new" ? newName.trim() || null : null;
  // The previous analyte's listing stays while the next loads, so the picker keeps its metabolites; its rows don't.
  const listing = useQuery({
    ...queries.measurements(experiment.id, requestedMetabolite),
    placeholderData: keepPreviousData,
  });
  const substrate = experiment.substrate ?? "Parent";
  const metabolites = (listing.data?.analytes ?? []).filter((analyte) => analyte.metabolite !== null);
  const clash = metabolites.find((analyte) => sameName(analyte.name, newName));
  const analyte: Analyte | null =
    choice.kind === "parent"
      ? { name: substrate, metabolite: null }
      : choice.kind === "metabolite"
        ? { name: choice.name, metabolite: choice.name }
        : newName.trim() && !clash
          ? { name: newName.trim(), metabolite: newName.trim() }
          : null;
  const rows = choice.kind === "new" || listing.isPlaceholderData ? [] : (listing.data?.rows ?? []);
  const last = experiment.stages.at(-1);
  const minutes = last?.incubation_minutes ?? null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="measurements-heading">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="w-72">
            <label htmlFor="analyte" className="text-sm font-bold text-ink-2">
              Analyte
            </label>
            <Select
              id="analyte"
              className="mt-1"
              value={choiceValue(choice)}
              disabled={saving}
              onChange={(event) => {
                const value = event.target.value;
                const next: Choice =
                  value === "parent" || value === NEW_METABOLITE
                    ? { kind: value === "parent" ? "parent" : "new" }
                    : { kind: "metabolite", name: value.replace(/^metabolite:/, "") };
                if (draftDirty) setPendingChoice(next);
                else {
                  setNotice(null);
                  setChoice(next);
                }
              }}
            >
              <option value="parent">{substrate} (parent)</option>
              {metabolites.map((entry) => (
                <option key={entry.name} value={`metabolite:${entry.name}`}>
                  {entry.name}
                </option>
              ))}
              <option value={NEW_METABOLITE}>New metabolite…</option>
            </Select>
          </div>
          {choice.kind === "new" ? (
            <div className="w-72">
              <label htmlFor="new-metabolite" className="text-sm font-bold text-ink-2">
                Metabolite name
              </label>
              <Input
                id="new-metabolite"
                className="mt-1"
                aria-describedby={clash ? "new-metabolite-hint" : undefined}
                value={newName}
                disabled={saving}
                onChange={(event) => setNewName(event.target.value)}
              />
              {clash ? (
                <p id="new-metabolite-hint" className="mt-1.5 text-sm font-bold text-warning-fg">
                  {clash.name} already has values here. Choose it above to replace them.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {pendingChoice ? (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning-line bg-warning-bg px-4 py-3">
            <p className="flex-1 text-warning-fg">This analyte has an unsaved bench data draft. Switching discards it.</p>
            <Button variant="outline" onClick={() => setPendingChoice(null)}>Keep editing</Button>
            <Button variant="destructive" onClick={() => {
              setNewName("");
              setNotice(null);
              setChoice(pendingChoice);
              setPendingChoice(null);
            }}>Discard draft and switch</Button>
          </div>
        ) : null}
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="measurements-heading" className="text-lg font-bold">
            {analyte?.name ?? "New metabolite"}, area ratio{minutes !== null ? ` at ${format.quantity(minutes, "min")}` : ""}
          </h2>
          {rows.length > 0 ? (
            <p className="text-sm text-ink-2">
              {format.count(rows.length, "value")}, each the peak-area ratio
              {experiment.internal_standard ? ` to ${experiment.internal_standard.compound}` : ""} read once at the end of the{" "}
              {last?.stage_type ?? "last"} stage.
            </p>
          ) : null}
        </div>
        {listing.isPending || listing.isPlaceholderData ? (
          <Loading label="Loading measurements…" />
        ) : listing.isError ? (
          <ErrorState title="Measurements could not load" error={listing.error} onRetry={() => listing.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={`No values for ${analyte?.name ?? "this metabolite"} yet`}>
            Paste one row per condition below. Copy the template first to get the conditions in order.
          </EmptyState>
        ) : (
          <EndpointGrid
            arms={listing.data.arms}
            rows={rows}
            styles={styles}
            caption={`${analyte?.name ?? "Analyte"} area ratios for ${experiment.code ?? "this experiment"}, by condition and replicate`}
          />
        )}
      </section>

      {listing.data ? (
        <EndpointPastePanel
          key={choiceValue(choice)}
          experiment={experiment}
          measurements={listing.data}
          analyte={analyte}
          draftName={choice.kind === "new" ? newName : ""}
          metadataPending={listing.isPlaceholderData}
          existing={rows.length}
          styles={styles}
          notice={notice}
          onEdit={() => setNotice(null)}
          onDraftChange={reportDraft}
          onSavingChange={setSaving}
          onSaved={(saved, count) => {
            setPendingChoice(null);
            const name = saved.analytes.find((entry) => sameName(entry.metabolite, analyte?.metabolite))?.name;
            setNotice(`Saved ${format.count(count, "measurement")} for ${name ?? analyte?.name ?? substrate}.`);
            if (name) setChoice({ kind: "metabolite", name });
            setNewName("");
          }}
        />
      ) : null}
    </div>
  );
}

/** One row per condition, one column per replicate up to the most any condition plans. A cell past a condition's
 * planned count is shaded; a planned one without a value shows a dash. */
function EndpointGrid({
  arms,
  rows,
  styles,
  caption,
}: {
  arms: readonly Schemas["ArmInfo"][];
  rows: readonly Read[];
  styles: ReadonlyMap<string, ArmStyle>;
  caption: string;
}) {
  const cells = new Map(rows.map((row) => [`${row.arm_key}|${row.replicate}`, row]));
  const width = Math.max(1, ...arms.map((arm) => arm.replicates), ...rows.map((row) => row.replicate));
  const replicates = Array.from({ length: width }, (_, index) => index + 1);
  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
      <table className="w-full border-collapse text-[0.9375rem] tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="px-3 py-2 text-left text-[0.8125rem] font-bold text-ink-2">
              Condition
            </th>
            {replicates.map((replicate) => (
              <th key={replicate} scope="col" className="px-3 py-2 text-right text-[0.8125rem] font-bold text-ink-3">
                R{replicate}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {arms.map((arm) => {
            const style = styles.get(arm.key);
            return (
              <tr key={arm.key} className="border-b border-rule last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-bold">
                  <span className="flex items-center gap-1.5">
                    {style ? <ArmSwatch style={style} size={14} /> : null}
                    {arm.label}
                  </span>
                </th>
                {replicates.map((replicate) => {
                  const value = cells.get(`${arm.key}|${replicate}`)?.raw_value;
                  const planned = replicate <= arm.replicates;
                  return (
                    <td
                      key={replicate}
                      className={cn("px-3 py-2 text-right", !planned && "bg-paper/60")}
                      title={planned ? undefined : "Not planned"}
                    >
                      {value !== null && value !== undefined ? String(value) : planned ? <span className="text-ink-3">–</span> : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type PasteInput = { text: string; metabolite: string | null };

/** The paste panel for a single endpoint: one row per condition, its label, then its replicates. A save replaces
 * the chosen analyte's values only. */
function EndpointPastePanel({
  experiment,
  measurements,
  analyte,
  draftName,
  metadataPending,
  existing,
  styles,
  notice,
  onEdit,
  onSaved,
  onDraftChange,
  onSavingChange,
}: {
  experiment: Schemas["ExperimentDetail"];
  measurements: Measurements;
  analyte: Analyte | null;
  draftName: string;
  metadataPending: boolean;
  existing: number;
  styles: ReadonlyMap<string, ArmStyle>;
  notice: string | null;
  onEdit: () => void;
  onSaved: (saved: Measurements, count: number) => void;
  onDraftChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ input: PasteInput; result: Schemas["PastePreview"] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const clipboard = useCopy();
  const [substrateText, setSubstrateText] = useState(() => {
    const saved = experiment.substrate_concentrations[0];
    return saved ? String(saved.value) : "";
  });
  const [substrateUnit, setSubstrateUnit] = useState(() => experiment.substrate_concentrations[0]?.unit ?? "uM");
  const confirmButton = useRef<HTMLButtonElement>(null);
  const template = [measurements.template_columns.join("\t"), ...measurements.arms.map((arm) => arm.label)].join("\n") + "\n";

  const requestPreview = useMutation({
    mutationFn: (input: PasteInput) =>
      mutations.pastePreview(experiment.id, { text: input.text, value_kind: "area_ratio", metabolite: input.metabolite }),
    onSuccess: (result, input) => {
      setPreview({ input, result });
      setConfirming(false);
    },
  });

  const replace = useMutation({
    mutationFn: (body: Schemas["ReplaceMeasurements"]) => mutations.replaceMeasurements(experiment.id, body),
    onSuccess: async (saved, body) => {
      queryClient.setQueryData(queries.measurements(experiment.id, body.metabolite ?? null).queryKey, saved);
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
      onSaved(saved, body.rows.length);
    },
  });

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const metabolite = analyte?.metabolite ?? null;
  const previewIsCurrent = preview !== null && preview.input.text === text && preview.input.metabolite === metabolite;
  const substrate = substrateConcentration(substrateText);
  const canSave =
    !metadataPending && analyte !== null && previewIsCurrent && preview.result.errors.length === 0 && preview.result.rows.length > 0 && substrate !== null;
  const name = analyte?.name ?? "this metabolite";
  useEffect(() => {
    onSavingChange(replace.isPending);
    return () => onSavingChange(false);
  }, [replace.isPending, onSavingChange]);
  const dirty = text !== "" || draftName !== "" ||
    substrateText !== (experiment.substrate_concentrations[0] ? String(experiment.substrate_concentrations[0].value) : "") ||
    substrateUnit !== (experiment.substrate_concentrations[0]?.unit ?? "uM");
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
        Paste one row per condition: its label, then its replicates, in the template's order. A row may hold fewer values
        than its planned replicates. A header row is optional. Values are area ratios; a metabolite may read 0.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={metadataPending || analyte === null} onClick={() => clipboard.copy(template, "Template")}>
          <Copy aria-hidden />
          Copy template
        </Button>
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
              onEdit();
            }}
            rows={8}
            wrap="off"
            spellCheck={false}
            placeholder={`${measurements.template_columns.join("    ")}\n${measurements.arms[0]?.label ?? ""}    …`}
            className="mt-1 min-h-40 w-full font-mono text-sm"
          />
        </div>
        <div className="flex flex-col gap-4">
          <SubstrateField text={substrateText} unit={substrateUnit} onText={setSubstrateText} onUnit={setSubstrateUnit} />
          <Button onClick={() => requestPreview.mutate({ text, metabolite })} disabled={metadataPending || text.trim() === "" || analyte === null || requestPreview.isPending}>
            <ClipboardPaste aria-hidden />
            {requestPreview.isPending ? "Reading…" : "Preview"}
          </Button>
          {analyte === null ? <p className="text-sm text-ink-3">Name the metabolite above to preview.</p> : null}
        </div>
      </div>

      {requestPreview.isError ? <ErrorState className="mt-5" title="The preview failed" error={requestPreview.error} /> : null}

      {notice !== null ? (
        <p role="status" className="mt-5 flex items-center gap-2 font-bold text-good-fg">
          <CircleCheck aria-hidden className="size-5" />
          {notice}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h3 className="text-base font-bold">Preview</h3>
            <p className="text-sm text-ink-2">
              {format.count(preview.result.rows.length, "value")} read as area ratios for {preview.input.metabolite ?? name}.
            </p>
          </div>
          {!previewIsCurrent ? (
            <p className="flex items-center gap-2 text-sm font-bold text-warning-fg">
              <TriangleAlert aria-hidden className="size-4" />
              The pasted block or analyte changed since this preview. Preview again before saving.
            </p>
          ) : null}
          <PreviewProblems result={preview.result} />
          {preview.result.rows.length > 0 ? (
            <EndpointGrid
              arms={measurements.arms}
              rows={preview.result.rows}
              styles={styles}
              caption="Pasted area ratios, by condition and replicate"
            />
          ) : null}

          {confirming ? (
            <div role="group" aria-labelledby="replace-heading" className="rounded-lg border border-warning-line bg-warning-bg px-4 py-4">
              <p id="replace-heading" className="font-bold text-ink">
                {existing > 0
                  ? `Replace ${format.count(existing, "saved value")} for ${name} with ${format.count(preview.result.rows.length, "pasted value")} at ${format.quantity(substrate, substrateUnit)} substrate?`
                  : `Save ${format.count(preview.result.rows.length, "pasted value")} for ${name} at ${format.quantity(substrate, substrateUnit)} substrate?`}
              </p>
              <p className="mt-1 max-w-[72ch] text-ink-2">
                {existing > 0
                  ? `This replaces every ${name} value for ${experiment.code ?? "this experiment"}. Other analytes stay as they are. It cannot be undone.`
                  : "Other analytes stay as they are."}
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
                      value_kind: "area_ratio",
                      substrate_concentration: substrate,
                      substrate_concentration_unit: substrateUnit,
                      metabolite: preview.input.metabolite,
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
              {substrate === null ? <p className="text-sm font-bold text-warning-fg">Enter the substrate concentration above to save.</p> : null}
            </div>
          )}
        </div>
      ) : null}
      </fieldset>
    </section>
  );
}
