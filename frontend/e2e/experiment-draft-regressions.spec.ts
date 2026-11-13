import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Schemas } from "../src/api/client";

const FETCH = { "X-Requested-With": "wetlab" };

async function experiment(request: APIRequestContext, sampling: "time_course" | "endpoint", multiTarget = false, substrateBlank = false) {
  const controls: Schemas["ControlIn"][] = [
    { stage: "primary", control_type: "vehicle", label: "Vehicle", solvent: "DMSO", solvent_percentage: 0.1, replicates: 3 },
  ];
  if (substrateBlank) controls.push({ stage: "primary", control_type: "minus_substrate", label: "No substrate", replicates: 3 });
  const body: Schemas["ExperimentIn"] = {
    title: "Experiment draft regression",
    study_type: "chemical_inhibition",
    substrate: "tucatinib",
    sampling,
    cofactors: [],
    pathways: [],
    condition: { incubation_temperature: 37, solvent: "DMSO", solvent_percentage: 0.1 },
    stages: [{ stage_type: "primary", incubation_minutes: 30, protein_concentration: 0.5 }],
    controls,
    arms: [{ stage: "primary", inhibitor: "ketoconazole", role: "inhibitor", cofactor_omitted: false, replicates: 3, target_enzyme: "CYP3A4", also_targets: multiTarget ? ["CYP3A5"] : [], concentration: 1, concentration_unit: "uM" }],
  };
  const response = await request.post("/api/experiments", { headers: FETCH, data: body });
  expect(response.status(), await response.text()).toBe(201);
  const created: Schemas["ExperimentDetail"] = await response.json();
  const measurements: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`)).json();
  return { created, measurements };
}

function timeCourseBlock(measurements: Schemas["Measurements"], lastPercent = 50) {
  return [
    measurements.template_columns.join("\t"),
    [0, ...measurements.arms.flatMap(() => [100, 100, 100])].join("\t"),
    [30, ...measurements.arms.flatMap(() => [lastPercent, lastPercent + 1, lastPercent - 1])].join("\t"),
  ].join("\n");
}

async function seedReads(request: APIRequestContext, id: number, measurements: Schemas["Measurements"], endpoint = false) {
  const rows = measurements.arms.flatMap((arm) => [1, 2, 3].flatMap((replicate) =>
    (endpoint ? [30] : [0, 10, 20, 30]).map((timepoint) => ({
      arm_key: arm.key,
      replicate,
      timepoint,
      ...(endpoint ? { raw_value: 0.8 } : {
        percent_of_t0: 100 * Math.exp(-(arm.kind === "control" ? 0.04 : 0.01) * timepoint + (replicate - 2) * timepoint / 1000),
      }),
    })),
  ));
  const response = await request.put(`/api/experiments/${id}/measurements`, {
    headers: FETCH,
    data: { rows, value_kind: endpoint ? "area_ratio" : "percent_of_t0", substrate_concentration: 1, substrate_concentration_unit: "uM" },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function switchTab(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name }).click();
}

test("bench drafts survive tab changes, final saves require the current preview, and setup does not load Plotly", async ({ page, request }) => {
  const { created, measurements } = await experiment(request, "time_course");
  const plotRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (/plotly/i.test(outgoing.url())) plotRequests.push(outgoing.url());
  });
  await page.goto(`/experiments/${created.id}/setup`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(created.title ?? "");
  await page.waitForLoadState("networkidle");
  expect(plotRequests).toEqual([]);

  await switchTab(page, "Bench data");
  await page.getByLabel("Pasted block").fill(timeCourseBlock(measurements));
  await page.getByRole("textbox", { name: "Substrate concentration", exact: true }).fill("1,0");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Save measurements", exact: true }).click();
  const confirmation = page.getByRole("group", { name: /^Save \d+ pasted values/ });
  const finalSave = confirmation.getByRole("button", { name: "Save measurements", exact: true });
  await expect(finalSave).toBeEnabled();
  const edited = timeCourseBlock(measurements, 25);
  await page.getByLabel("Pasted block").fill(edited);
  await expect(finalSave).toBeDisabled();

  await switchTab(page, "Setup");
  await switchTab(page, "Bench data");
  await expect(page.getByLabel("Pasted block")).toHaveValue(edited);
  await expect(finalSave).toBeDisabled();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("bench data draft");
  await page.getByRole("button", { name: "Stay on this experiment" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Save measurements", exact: true }).click();
  const saved = page.waitForResponse((response) => response.url().endsWith("/measurements") && response.request().method() === "PUT");
  await confirmation.getByRole("button", { name: "Save measurements", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("textbox", { name: "Substrate concentration", exact: true })).toHaveValue("1");
  await expect(page.getByRole("navigation", { name: "Experiment sections" }).getByTitle("Unsaved changes")).toHaveCount(0);
  const stored: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`)).json();
  expect(stored.rows.filter((row) => row.timepoint === 30).map((row) => row.percent_of_t0 ?? NaN).sort((a, b) => a - b)).toEqual([24, 24, 25, 25, 26, 26]);
});

test("changing a new metabolite after confirmation cannot overwrite parent reads", async ({ page, request }) => {
  const { created, measurements } = await experiment(request, "endpoint");
  await seedReads(request, created.id, measurements, true);
  await page.goto(`/experiments/${created.id}/bench`);
  await page.getByLabel("Analyte", { exact: true }).selectOption("new");
  await page.getByLabel("Metabolite name", { exact: true }).fill("Draft metabolite");
  await page.getByLabel("Pasted block").fill(measurements.arms.map((arm) => [arm.label, 0.2, 0.3, 0.4].join("\t")).join("\n"));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Save measurements", exact: true }).click();
  const confirmation = page.getByRole("group", { name: /^Save \d+ pasted values/ });
  const finalSave = confirmation.getByRole("button", { name: "Save measurements", exact: true });
  await page.getByLabel("Metabolite name", { exact: true }).fill("");
  await expect(finalSave).toBeDisabled();
  await page.getByLabel("Metabolite name", { exact: true }).fill("Final metabolite");
  await expect(finalSave).toBeDisabled();
  await page.getByLabel("Analyte", { exact: true }).selectOption("parent");
  await expect(page.getByRole("alert")).toContainText("Switching discards it");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Metabolite name", { exact: true })).toHaveValue("Final metabolite");

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Save measurements", exact: true }).click();
  const saved = page.waitForResponse((response) => response.url().endsWith("/measurements") && response.request().method() === "PUT");
  await confirmation.getByRole("button", { name: "Save measurements", exact: true }).click();
  expect((await saved).status()).toBe(200);
  const parent: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`)).json();
  expect(parent.rows).toHaveLength(6);
  expect(parent.rows.every((row) => row.raw_value === 0.8)).toBe(true);
  const metabolite: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`, { params: { metabolite: "Final metabolite" } })).json();
  expect(metabolite.rows.map((row) => row.raw_value ?? NaN).sort((a, b) => a - b)).toEqual([0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
});

test("edits made during a results save remain unsaved, and Edit details asks before discarding them", async ({ page, request }) => {
  const { created, measurements } = await experiment(request, "time_course");
  await seedReads(request, created.id, measurements);
  const original: Schemas["DepletionResult"] = await (await request.get(`/api/experiments/${created.id}/depletion`)).json();
  const control = original.arms.find((arm) => arm.kind === "control");
  const first = control?.points.find((point) => point.timepoint === 10 && point.replicate === 1);
  const second = control?.points.find((point) => point.timepoint === 20 && point.replicate === 1);
  if (!first || !second) throw new Error("The fixture needs two control points.");
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/depletion/save", async (route) => { await gate; await route.continue(); });
  await page.goto(`/experiments/${created.id}/results`);
  await page.getByRole("button", { name: /^Points/ }).click();
  const firstRow = page.getByTestId(`point-${first.measurement_id}`);
  const secondRow = page.getByTestId(`point-${second.measurement_id}`);
  await firstRow.getByRole("checkbox").check();
  await firstRow.getByRole("combobox").selectOption("carryover");
  const started = page.waitForRequest((outgoing) => outgoing.url().endsWith("/depletion/save"));
  await page.getByTestId("save-results").click();
  await started;
  await secondRow.getByRole("checkbox").check();
  await secondRow.getByRole("combobox").selectOption("carryover");
  await expect(page.getByTestId("save-results")).toBeDisabled();
  await switchTab(page, "Bench data");
  await switchTab(page, "Results");
  await expect(page.getByTestId("save-results")).toBeDisabled();
  const completed = page.waitForResponse((response) => response.url().endsWith("/depletion/save"));
  release();
  expect((await completed).status()).toBe(200);
  await expect(secondRow.getByRole("checkbox")).toBeChecked();
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  const stored: Schemas["DepletionResult"] = await (await request.get(`/api/experiments/${created.id}/depletion`)).json();
  expect(stored.arms.flatMap((arm) => arm.points).find((point) => point.measurement_id === second.measurement_id)?.excluded).toBe(false);
  await page.getByRole("link", { name: "Edit details", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("exclusions on the Results tab");
  await page.getByRole("button", { name: "Stay on this experiment" }).click();
  await expect(secondRow.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
});

test("multi-target inhibition explains why individual enzyme fm is unavailable", async ({ page, request }) => {
  const { created, measurements } = await experiment(request, "time_course", true);
  await seedReads(request, created.id, measurements);
  await page.goto(`/experiments/${created.id}/results`);
  const note = "targets CYP3A4, CYP3A5; their individual fm cannot be determined from this inhibition";
  await expect(page.getByRole("region", { name: "Per-arm results" })).toContainText(note);
  await expect(page.getByRole("region", { name: "Apparent fm by enzyme" })).toContainText(note);
  await expect(page.getByRole("region", { name: "Per-arm results" })).not.toContainText("not detectable");
});

test("a new metabolite includes substrate-free controls and preserves its draft while renaming", async ({ page, request }) => {
  const { created, measurements } = await experiment(request, "endpoint", false, true);
  expect(measurements.arms.some((arm) => arm.control_type === "minus_substrate")).toBe(false);
  const full: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`, { params: { metabolite: "Blank metabolite" } })).json();
  expect(full.arms.some((arm) => arm.control_type === "minus_substrate")).toBe(true);
  await page.goto(`/experiments/${created.id}/bench`);
  await page.getByLabel("Analyte", { exact: true }).selectOption("new");
  await page.getByLabel("Metabolite name", { exact: true }).fill("Blank metabolite");
  await expect(page.getByRole("button", { name: "Copy template", exact: true })).toBeEnabled();
  const block = full.arms.map((arm) => [arm.label, ...(arm.control_type === "minus_substrate" ? [0, 0, 0] : [0.1, 0.2, 0.3])].join("\t")).join("\n");
  await page.getByLabel("Pasted block").fill(block);
  await page.getByRole("textbox", { name: "Substrate concentration", exact: true }).fill("1");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save measurements", exact: true })).toBeEnabled();
  await page.getByLabel("Metabolite name", { exact: true }).fill("Renamed blank metabolite");
  await expect(page.getByLabel("Pasted block")).toHaveValue(block);
  await expect(page.getByRole("button", { name: "Save measurements", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Save measurements", exact: true }).click();
  const confirmation = page.getByRole("group", { name: /^Save \d+ pasted values/ });
  const saved = page.waitForResponse((response) => response.url().endsWith("/measurements") && response.request().method() === "PUT");
  await confirmation.getByRole("button", { name: "Save measurements", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "Saved 9 measurements" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Substrate concentration", exact: true })).toHaveValue("1");
  await expect(page.getByRole("navigation", { name: "Experiment sections" }).getByTitle("Unsaved changes")).toHaveCount(0);
  const stored: Schemas["Measurements"] = await (await request.get(`/api/experiments/${created.id}/measurements`, { params: { metabolite: "Renamed blank metabolite" } })).json();
  const blank = stored.arms.find((arm) => arm.control_type === "minus_substrate");
  expect(blank).toBeDefined();
  expect(stored.rows.filter((row) => row.arm_key === blank?.key).map((row) => row.raw_value)).toEqual([0, 0, 0]);
});
