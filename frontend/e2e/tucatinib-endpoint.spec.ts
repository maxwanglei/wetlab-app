import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");

/** The three inhibitor sets of the protocol "Tucatinib Incubation with CYP2C8 and CYP3A Inhibitors, Pooled HLM,
 * 7-15-26". The gem-gluc set runs 30 min of the 5-min primary stage; ketoconazole enters the secondary stage. */
const SERIES = [
  { name: "gemfibrozil O-glucuronide", target: "CYP2C8", stage: "Primary", minutes: "30", concentrations: ["1", "2", "4", "8", "16", "32", "64"] },
  { name: "CYP3cide", target: "CYP3A4", stage: "Primary", concentrations: ["0.01", "0.02", "0.05", "0.1", "0.2", "0.5", "1.3"] },
  { name: "ketoconazole", target: "CYP3A4", also: "CYP3A5", stage: "Secondary", concentrations: ["0.01", "0.02", "0.05", "0.1", "0.2", "0.5", "1"] },
] as const;

function controls(stage: Locator): Locator {
  return stage.getByRole("group", { name: /^Control: / });
}

async function addControl(
  stage: Locator,
  at: number,
  { label, minusNadph = false, minutes, replicates }: { label: string; minusNadph?: boolean; minutes?: string; replicates?: string },
) {
  if (at > 0) await stage.getByRole("button", { name: "Add control" }).click();
  const control = controls(stage).nth(at);
  if (minusNadph) {
    await control.getByLabel("Type").selectOption("minus_cofactor");
    await control.getByLabel("Leaves out").selectOption({ label: "NADPH" });
  }
  await control.getByLabel("Label", { exact: true }).fill(label);
  if (minutes) await control.getByLabel("Time in its stage").fill(minutes);
  if (replicates) await control.getByLabel(/^Replicates/).fill(replicates);
}

/** A block as the LC-MS sheet gives it: the template's header, then each condition's label and its planned
 * replicates, a run without cofactor holding one value. */
function pastedBlock(listing: Schemas["Measurements"], value: (arm: Schemas["ArmInfo"], replicate: number) => string): string {
  const rows = listing.arms.map((arm) =>
    [arm.label, ...Array.from({ length: arm.replicates }, (_, index) => value(arm, index + 1))].join("\t"),
  );
  return [listing.template_columns.join("\t"), ...rows].join("\n");
}

const withoutCofactor = (arm: Schemas["ArmInfo"]) => arm.cofactor_omitted || arm.control_type === "minus_cofactor";
const parentRatio = (arm: Schemas["ArmInfo"], replicate: number) =>
  withoutCofactor(arm) ? "0.98" : (0.6 + 0.01 * replicate + (arm.concentration ?? 0) / 1000).toFixed(4);
const metaboliteRatio = (arm: Schemas["ArmInfo"], replicate: number) => (withoutCofactor(arm) ? "0" : (0.1 + 0.001 * replicate).toFixed(3));

async function pasteAndSave(page: Page, block: string, analyte: string, count: number) {
  await page.getByLabel("Pasted block").fill(block);
  await page.getByRole("textbox", { name: "Substrate concentration", exact: true }).fill("1");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(`${count} values read as area ratios for ${analyte}.`)).toBeVisible();
  await page.getByRole("button", { name: "Save measurements" }).click();
  const confirm = page.getByRole("group", { name: `Save ${count} pasted values for ${analyte} at 1 µM substrate?` });
  const saved = page.waitForResponse((response) => response.url().endsWith("/measurements") && response.request().method() === "PUT");
  await confirm.getByRole("button", { name: "Save measurements" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: `Saved ${count} measurements for ${analyte}.` })).toBeVisible();
}

/** The cells of a CSV line, with quoted cells holding commas. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quoted && char === '"' && line[at + 1] === '"') {
      cell += '"';
      at += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  return [...out, cell];
}

test("the tucatinib protocol is planned as a single endpoint, and its parent and a metabolite are pasted and exported", async ({
  page,
  request,
}) => {
  let created: Schemas["ExperimentDetail"] | undefined;

  await test.step("plan the protocol in the form", async () => {
    await page.goto("/experiments/new");
    await page.getByLabel("Title").fill("Tucatinib Incubation with CYP2C8 and CYP3A Inhibitors in Pooled HLM");
    await page.getByLabel("Study type").selectOption({ label: "Chemical inhibition" });
    await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("tucatinib");
    const conditions = page.getByRole("region", { name: "Incubation conditions" });
    await conditions.getByLabel("Solvent", { exact: true }).fill("DMSO/ACN 1:9");
    await conditions.getByLabel("Solvent, final").fill("0.5");

    const components = page.getByRole("region", { name: "Components", exact: true });
    await components.getByRole("button", { name: "Add component" }).click();
    const nadph = components.getByRole("group", { name: /^Component 1/ });
    await nadph.getByRole("textbox", { name: "Component", exact: true }).fill("NADPH");
    await nadph.getByLabel("Role").selectOption("cofactor");

    await page.getByLabel("Sampling", { exact: true }).selectOption({ label: "Single endpoint" });
    const primary = page.getByRole("group", { name: /^Primary stage/ });
    await primary.getByLabel("Incubation", { exact: true }).fill("5");
    await primary.getByLabel("Protein", { exact: true }).fill("0.5");
    await addControl(primary, 0, { label: "Vehicle, Gem-gluc set", minutes: "30" });
    await addControl(primary, 1, { label: "Vehicle, CYP3cide set" });
    await addControl(primary, 2, { label: "Minus NADPH, Gem-gluc set", minusNadph: true, minutes: "30", replicates: "1" });
    await addControl(primary, 3, { label: "Minus NADPH, CYP3cide set", minusNadph: true, replicates: "1" });

    await page.getByRole("button", { name: "Add stage" }).click();
    const secondary = page.getByRole("group", { name: /^Secondary stage/ });
    await secondary.getByLabel("Dilution from the primary stage").fill("10");
    await secondary.getByLabel("Incubation", { exact: true }).fill("10");
    await secondary.getByLabel("Protein", { exact: true }).fill("0.05");
    await addControl(secondary, 0, { label: "Vehicle, Keto set" });
    await addControl(secondary, 1, { label: "Minus NADPH, Keto set", minusNadph: true, replicates: "1" });

    const standard = page.getByRole("region", { name: "Internal standard" });
    await standard.getByLabel("Compound").fill("D3-imatinib");
    await standard.getByLabel("Concentration", { exact: true }).fill("100");
    await standard.getByLabel("Internal standard unit").selectOption("ng/mL");

    for (const [index, series] of SERIES.entries()) {
      await page.getByRole("button", { name: "Add inhibitor arm" }).click();
      const arm = page.getByRole("group", { name: new RegExp(`^Arm ${index + 1}`) });
      await arm.getByLabel("Inhibitor").fill(series.name);
      await arm.getByLabel("Target enzyme").fill(series.target);
      if ("also" in series) {
        await arm.getByRole("button", { name: "Add target" }).click();
        await arm.getByLabel(/^Also target 1/).fill(series.also);
      }
      await arm.getByLabel("Stage it enters").selectOption({ label: series.stage });
      if ("minutes" in series) await arm.getByLabel("Time in its stage").fill(series.minutes);
      await expect(arm.getByLabel(/^Replicates(?! without)/)).toHaveValue("3");
      await arm.getByLabel("Concentration 1", { exact: true }).fill(series.concentrations[0]);
      for (const [at, value] of series.concentrations.slice(1).entries()) {
        await arm.getByRole("button", { name: "Add concentration" }).click();
        await arm.getByLabel(`Concentration ${at + 2}`, { exact: true }).fill(value);
      }
      await arm.getByLabel("Also run each concentration without a cofactor").check();
      await expect(arm.getByLabel("Cofactor left out")).toHaveValue(/\d+/);
      await arm.getByLabel(/^Replicates without cofactor/).fill("1");
    }
    for (const [index, enzyme] of ["CYP2C8", "CYP3A4", "CYP3A5"].entries()) {
      await page.getByRole("button", { name: "Add pathway" }).click();
      await page.getByRole("group", { name: new RegExp(`^Pathway ${index + 1}`) }).getByLabel("Enzyme").fill(enzyme);
    }
    await page.screenshot({ path: `${screenshots}/27-tucatinib-endpoint-form.png`, fullPage: true });

    const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/experiments") && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "Create experiment" }).click();
    const posted = await response;
    expect(posted.status(), await posted.text()).toBe(201);
    created = await posted.json();
    const sent: Schemas["ExperimentIn"] = posted.request().postDataJSON();
    expect([sent.sampling, sent.arms?.length, sent.controls?.length]).toEqual(["endpoint", 42, 6]);
  });
  if (!created) throw new Error("the experiment was not created");
  const experimentId = created.id;

  await test.step("the Setup tab matches every condition to the control with its own time", async () => {
    await page.goto(`/experiments/${experimentId}/setup`);
    await expect(page.getByTestId("design-summary")).toContainText(
      "Sampling: Single endpoint, each condition read once at the end of the secondary stage (10 min)",
    );
    await expect(page.getByText("None chosen")).toHaveCount(0);
    const controlTable = page.getByRole("region", { name: "Controls" });
    await expect(controlTable.getByRole("row", { name: /^Minus NADPH, Gem-gluc set \(primary\)/ })).toContainText("Vehicle, Gem-gluc set (primary)");
    await expect(controlTable.getByRole("row", { name: /^Minus NADPH, CYP3cide set \(primary\)/ })).toContainText("Vehicle, CYP3cide set (primary)");
    await expect(controlTable.getByRole("row", { name: /^Minus NADPH, Keto set \(secondary\)/ })).toContainText("Vehicle, Keto set (secondary)");

    const arms = page.getByRole("region", { name: "Arms" });
    await expect(arms).toContainText("Each condition is read once, at the end of the last stage.");
    await expect(arms.getByRole("row", { name: /^ketoconazole 1 uM \(secondary\)/ })).toContainText("CYP3A4, CYP3A5");
    const gemfibrozil = arms.getByRole("row", { name: /^gemfibrozil O-glucuronide 64 uM \(primary\)/ });
    await expect(gemfibrozil).toContainText("64 µM (6.4 µM in secondary)");
    await expect(gemfibrozil).toContainText("30 min in its stage");
    await expect(gemfibrozil).toContainText("3 replicates");
    await expect(gemfibrozil).toContainText("Vehicle, Gem-gluc set (primary)");
    await expect(arms.getByRole("row", { name: /^gemfibrozil O-glucuronide 64 uM minus NADPH \(primary\)/ })).toContainText(
      "Minus NADPH, Gem-gluc set (primary)",
    );
    const cyp3cide = arms.getByRole("row", { name: /^CYP3cide 1\.3 uM \(primary\)/ });
    await expect(cyp3cide).toContainText("5 min in its stage");
    await expect(cyp3cide).toContainText("Vehicle, CYP3cide set (primary)");
    const cyp3cideTwin = arms.getByRole("row", { name: /^CYP3cide 1\.3 uM minus NADPH \(primary\)/ });
    await expect(cyp3cideTwin).toContainText("5 min in its stage");
    await expect(cyp3cideTwin).toContainText("1 replicate");
    await expect(cyp3cideTwin).toContainText("Minus NADPH, CYP3cide set (primary)");
    await page.screenshot({ path: `${screenshots}/28-tucatinib-endpoint-setup.png`, fullPage: true });
  });

  const listing: Schemas["Measurements"] = await (await request.get(`/api/experiments/${experimentId}/measurements`)).json();
  const values = listing.arms.reduce((total, arm) => total + arm.replicates, 0);
  expect(values).toBe(96);

  await test.step("the parent's area ratios are pasted one row per condition, a run without NADPH holding one", async () => {
    await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name: "Bench data" }).click();
    await expect(page.getByRole("heading", { name: "tucatinib, area ratio at 10 min" })).toBeVisible();
    await pasteAndSave(page, pastedBlock(listing, parentRatio), "tucatinib", values);
    const table = page.getByRole("table", { name: /^tucatinib area ratios/ });
    await expect(table.getByRole("row", { name: /^Vehicle, Gem-gluc set \(primary\)/ })).toHaveText(/0\.61\s*0\.62\s*0\.63$/);
    await expect(table.getByRole("row", { name: /^Minus NADPH, Keto set \(secondary\)/ })).toHaveText(/\(secondary\)\s*0\.98$/);
    await page.screenshot({ path: `${screenshots}/29-endpoint-parent-saved.png`, fullPage: true });
  });

  await test.step("a new metabolite is pasted beside the parent, which keeps its values", async () => {
    const analyte = page.getByLabel("Analyte", { exact: true });
    await analyte.selectOption({ label: "New metabolite…" });
    await page.getByLabel("Metabolite name").fill("hydroxy-tucatinib");
    await expect(page.getByRole("heading", { name: "hydroxy-tucatinib, area ratio at 10 min" })).toBeVisible();
    await pasteAndSave(page, pastedBlock(listing, metaboliteRatio), "hydroxy-tucatinib", values);
    await expect(analyte.locator("option:checked")).toHaveText("hydroxy-tucatinib");
    await expect(analyte.locator("option")).toHaveText(["tucatinib (parent)", "hydroxy-tucatinib", "New metabolite…"]);
    const table = page.getByRole("table", { name: /^hydroxy-tucatinib area ratios/ });
    await expect(table.getByRole("row", { name: /^Vehicle, CYP3cide set \(primary\)/ })).toHaveText(/0\.101\s*0\.102\s*0\.103$/);
    await expect(table.getByRole("row", { name: /^Minus NADPH, Gem-gluc set \(primary\)/ })).toHaveText(/\(primary\)\s*0$/);
    await page.screenshot({ path: `${screenshots}/30-endpoint-metabolite-saved.png`, fullPage: true });

    await analyte.selectOption({ label: "tucatinib (parent)" });
    await expect(page.getByRole("table", { name: /^tucatinib area ratios/ }).getByRole("row", { name: /^Vehicle, Gem-gluc set/ })).toHaveText(
      /0\.61\s*0\.62\s*0\.63$/,
    );
  });

  await test.step("Results points to the raw data, and the CSV names each row's analyte and its condition's time", async () => {
    await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name: "Results" }).click();
    await expect(page.getByText("Analysis for single-endpoint experiments is not built yet")).toBeVisible();
    await page.screenshot({ path: `${screenshots}/31-endpoint-results-notice.png`, fullPage: true });
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download CSV" }).click();
    const text = (await readFile(await (await download).path())).toString("utf-8");
    const [header = [], ...rows] = text.slice(1).trimEnd().split("\r\n").map(cells);
    const column = (name: string) => header.indexOf(name);
    expect(rows).toHaveLength(2 * values);
    const byAnalyte = (name: string) => rows.filter((row) => row[column("analyte")] === name);
    expect([byAnalyte("tucatinib").length, byAnalyte("hydroxy-tucatinib").length]).toEqual([values, values]);
    const minutes = (label: RegExp) => new Set(rows.filter((row) => label.test(row[column("series_label")] ?? "")).map((row) => row[column("condition_minutes")]));
    expect(minutes(/^gemfibrozil O-glucuronide/)).toEqual(new Set(["30"]));
    expect(minutes(/^CYP3cide/)).toEqual(new Set(["5"]));
    expect(minutes(/^Vehicle, Gem-gluc set/)).toEqual(new Set(["30"]));
    expect(minutes(/^ketoconazole/)).toEqual(new Set(["10"]));
    const vehicle = byAnalyte("hydroxy-tucatinib").find((row) => row[column("series_label")] === "Vehicle, Gem-gluc set (primary)");
    expect([vehicle?.[column("raw_value")], vehicle?.[column("time")], vehicle?.[column("stage_sampled")]]).toEqual(["0.101", "10", "secondary"]);
  });
});
