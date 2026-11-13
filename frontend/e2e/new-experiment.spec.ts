import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");
const TIMEPOINTS = [0, 5, 15, 30, 45, 60];
const PROTEIN_MG_PER_ML = 0.5;

/** First-order depletion rates (per min) the pasted values follow exactly, by condition label. Montelukast
 * slows depletion more at each concentration, and less again without NADPH; minus NADPH stays flat. */
const RATES: Record<string, number> = {
  "Vehicle control (DMSO 0.1%)": 0.03,
  "Vehicle control (acetonitrile 0.5%)": 0.024,
  ketoconazole: 0.006,
  "montelukast 0.1 uM": 0.02,
  "montelukast 1 uM": 0.016,
  "montelukast 10 uM": 0.012,
  "montelukast 0.1 uM minus NADPH": 0.02,
  "montelukast 1 uM minus NADPH": 0.018,
  "montelukast 10 uM minus NADPH": 0.016,
  "Minus NADPH": 0,
};

/** CLint,app in µL/min/mg protein: k (1/min) divided by the protein concentration (mg/mL), times 1000 µL/mL. */
function expectedClint(k: number): string {
  return ((k / PROTEIN_MG_PER_ML) * 1000).toFixed(1);
}

function percentRemaining(k: number, minutes: number): string {
  return (100 * Math.exp(-k * minutes)).toFixed(4);
}

/** A control row by its position in the stage; its accessible name follows its label, which changes as it is typed. */
function control(stage: Locator, position: number): Locator {
  return stage.getByRole("group", { name: /^Control: / }).nth(position);
}

function named(stage: Locator, name: string): Locator {
  return stage.getByRole("group", { name: `Control: ${name}`, exact: true });
}

async function region(page: Page, name: string): Promise<Locator> {
  const found = page.getByRole("region", { name });
  await expect(found).toBeVisible();
  return found;
}

test("plan a stage with two vehicles, an inhibitor series run with and without NADPH, and a negative control", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reference: Schemas["ReferenceData"] = await (await request.get("/api/reference")).json();
  const hlm = reference.tissue_lots.find((lot) => lot.lot_number === "HLM10-2606");
  const ketoconazoleLot = reference.reagent_lots.find((lot) => lot.lot_number === "KTZ-25088");
  if (!hlm || !ketoconazoleLot) throw new Error("the seed has no HLM10-2606 tissue lot or KTZ-25088 ketoconazole lot");

  let created: Schemas["ExperimentDetail"] | undefined;
  const placeholders: string[] = [];

  await test.step("the New experiment form plans the design in the browser", async () => {
    await page.goto("/experiments");
    await page.getByRole("link", { name: "New experiment" }).click();
    await expect(page).toHaveURL(/\/experiments\/new$/);

    await page.getByLabel("Title").fill("Amodiaquine with two vehicles and a montelukast series");
    await page.getByLabel("Study type").selectOption({ label: "Chemical inhibition" });
    await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("amodiaquine");
    await page.getByLabel("Tissue lot").selectOption(String(hlm.id));
    const primary = page.getByRole("group", { name: /^Primary stage/ });
    await primary.getByLabel("Protein", { exact: true }).fill(String(PROTEIN_MG_PER_ML));
    await primary.getByLabel("Incubation", { exact: true }).fill("60");
    const conditions = await region(page, "Incubation conditions");
    await expect(conditions.getByLabel("Temperature")).toHaveValue("37");
    await conditions.getByLabel("Solvent", { exact: true }).fill("DMSO");
    await conditions.getByLabel("Solvent, final").fill("0.1");

    const components = page.getByRole("region", { name: "Components", exact: true });
    await expect(components.getByText("No components listed yet.")).toBeVisible();
    await components.getByRole("button", { name: "Add component" }).click();
    const nadph = components.getByRole("group", { name: /^Component 1/ });
    await expect(nadph.getByRole("textbox", { name: "Component", exact: true })).toBeFocused();
    await nadph.getByRole("textbox", { name: "Component", exact: true }).fill("NADPH");
    await nadph.getByLabel("Role").selectOption("cofactor");
    await nadph.getByLabel("Concentration", { exact: true }).fill("1");

    await expect(named(primary, "Vehicle control").getByLabel("Type")).toHaveValue("vehicle");
    await control(primary, 0).getByLabel("Solvent", { exact: true }).fill("DMSO");
    await control(primary, 0).getByLabel("Solvent, final").fill("0.1");

    await primary.getByRole("button", { name: "Add control" }).click();
    await expect(control(primary, 1).getByLabel("Type")).toBeFocused();
    await expect(named(primary, "Vehicle control (DMSO 0.1%)")).toBeVisible();
    await control(primary, 1).getByLabel("Solvent", { exact: true }).fill("acetonitrile");
    await control(primary, 1).getByLabel("Solvent, final").fill("0.5");
    await expect(named(primary, "Vehicle control (acetonitrile 0.5%)").getByLabel("Label", { exact: true })).toHaveAttribute(
      "placeholder",
      "Vehicle control (acetonitrile 0.5%)",
    );

    await primary.getByRole("button", { name: "Add control" }).click();
    await control(primary, 2).getByLabel("Type").selectOption("minus_cofactor");
    await expect(named(primary, "Minus all cofactors")).toBeVisible();
    await control(primary, 2).getByLabel("Leaves out").selectOption({ label: "NADPH" });
    await expect(named(primary, "Minus NADPH").getByLabel("Label", { exact: true })).toHaveAttribute("placeholder", "Minus NADPH");
    for (const label of await primary.getByLabel("Label", { exact: true }).all()) {
      placeholders.push((await label.getAttribute("placeholder")) ?? "");
    }

    await page.getByRole("button", { name: "Add inhibitor arm" }).click();
    const ketoconazole = page.getByRole("group", { name: /^Arm 1/ });
    await expect(ketoconazole.getByLabel("Inhibitor")).toBeFocused();
    await ketoconazole.getByLabel("Inhibitor").fill("ketoconazole");
    await ketoconazole.getByLabel("Target enzyme").fill("CYP3A4");
    await ketoconazole.getByLabel("Lot").selectOption(String(ketoconazoleLot.id));
    await ketoconazole.getByLabel("Solvent", { exact: true }).selectOption({ label: "0.1% DMSO, as Vehicle control (DMSO 0.1%)" });
    await ketoconazole.getByLabel("Concentration 1", { exact: true }).fill("1");

    await page.getByRole("button", { name: "Add inhibitor arm" }).click();
    const montelukast = page.getByRole("group", { name: /^Arm 2/ });
    await montelukast.getByLabel("Inhibitor").fill("montelukast");
    await montelukast.getByLabel("Target enzyme").fill("CYP2C8");
    await montelukast.getByLabel("Solvent", { exact: true }).selectOption({ label: "0.5% acetonitrile, as Vehicle control (acetonitrile 0.5%)" });
    await montelukast.getByLabel("Concentration 1", { exact: true }).fill("0.1");
    for (const [index, value] of ["1", "10"].entries()) {
      await montelukast.getByRole("button", { name: "Add concentration" }).click();
      await expect(montelukast.getByLabel(`Concentration ${index + 2}`, { exact: true })).toBeFocused();
      await montelukast.getByLabel(`Concentration ${index + 2}`, { exact: true }).fill(value);
    }
    await montelukast.getByLabel("Also run each concentration without a cofactor").check();
    await expect(montelukast.getByLabel("Cofactor left out")).toHaveValue(/\d+/);
    await expect(montelukast.getByText("Add a control to the primary stage")).toHaveCount(0);
    await expect(montelukast.getByLabel("Compared against")).toHaveValue("");

    await page.getByRole("button", { name: "Add pathway" }).click();
    await page.getByRole("group", { name: /^Pathway 1/ }).getByLabel("Enzyme").fill("CYP3A4");
    await page.getByRole("button", { name: "Add pathway" }).click();
    await page.getByRole("group", { name: /^Pathway 2/ }).getByLabel("Enzyme").fill("CYP2C8");
    await page.screenshot({ path: `${screenshots}/12-new-experiment-form.png`, fullPage: true });
  });

  await test.step("Create sends one arm per concentration and run without NADPH, and lands on Bench data", async () => {
    const response = page.waitForResponse(
      (candidate) => candidate.url().endsWith("/api/experiments") && candidate.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create experiment" }).click();
    const posted = await response;
    expect(posted.status()).toBe(201);
    const shared = { role: "inhibitor", concentration_unit: "uM", stage: "primary" };
    const montelukast = (concentration: number, omitted: boolean) => ({
      ...shared,
      inhibitor: "montelukast",
      target_enzyme: "CYP2C8",
      reagent_lot_id: null,
      solvent: "acetonitrile",
      solvent_percentage: 0.5,
      concentration,
      cofactor_omitted: omitted,
      omitted_cofactor: omitted ? 0 : null,
      reference_control: null,
    });
    expect(posted.request().postDataJSON()).toMatchObject({
      study_type: "chemical_inhibition",
      substrate: "amodiaquine",
      tissue_lot_id: hlm.id,
      condition: { incubation_temperature: 37, solvent: "DMSO", solvent_percentage: 0.1 },
      stages: [
        { stage_type: "primary", incubation_minutes: 60, protein_concentration: PROTEIN_MG_PER_ML, dilution_factor: null, diluted_from: null },
      ],
      cofactors: [{ cofactor: "NADPH", role: "cofactor", concentration: 1, concentration_unit: "mM", solution: null }],
      controls: [
        { stage: "primary", control_type: "vehicle", label: null, solvent: "DMSO", solvent_percentage: 0.1, omitted_cofactor: null },
        { stage: "primary", control_type: "vehicle", label: null, solvent: "acetonitrile", solvent_percentage: 0.5, omitted_cofactor: null },
        { stage: "primary", control_type: "minus_cofactor", label: null, solvent: null, omitted_cofactor: 0, protein_concentration: null },
      ],
      arms: [
        {
          ...shared,
          inhibitor: "ketoconazole",
          target_enzyme: "CYP3A4",
          reagent_lot_id: ketoconazoleLot.id,
          solvent: "DMSO",
          solvent_percentage: 0.1,
          concentration: 1,
          cofactor_omitted: false,
          omitted_cofactor: null,
          reference_control: null,
        },
        montelukast(0.1, false),
        montelukast(1, false),
        montelukast(10, false),
        montelukast(0.1, true),
        montelukast(1, true),
        montelukast(10, true),
      ],
      pathways: [
        { enzyme: "CYP3A4", pathway_role: "major" },
        { enzyme: "CYP2C8", pathway_role: "major" },
      ],
      internal_standard: null,
    });
    created = await posted.json();
    expect(created?.code).toMatch(/^WL-\d{4}-\d{3}$/);
    expect(created?.status).toBe("planned");
    const stored = created?.arms.filter((arm) => arm.control_id !== null).map((arm) => arm.label);
    expect(stored, "the form's placeholders are the labels the API gives").toEqual(placeholders);

    await expect(page).toHaveURL(new RegExp(`/experiments/${created?.id}/bench$`));
    await expect(page.getByText(`${created?.code} is planned and ready for bench data.`)).toBeVisible();
    await expect(page.getByText("No measurements yet")).toBeVisible();
    await page.screenshot({ path: `${screenshots}/13-planned-bench-tab.png`, fullPage: true });
  });

  await test.step("a reload of the Setup tab shows every control and arm as entered", async () => {
    await page.getByRole("link", { name: "Setup" }).click();
    await page.reload();
    const controls = page.getByRole("region", { name: "Controls" });
    await expect(controls.getByRole("row", { name: /^Vehicle control \(DMSO 0\.1%\)/ })).toContainText("0.1% DMSO");
    await expect(controls.getByRole("row", { name: /^Vehicle control \(acetonitrile 0\.5%\)/ })).toContainText("0.5% acetonitrile");
    const negative = controls.getByRole("row", { name: /^Minus NADPH/ });
    await expect(negative).toContainText("Negative control");
    await expect(negative).toContainText("NADPH");
    await expect(negative).toContainText("Vehicle control (DMSO 0.1%)");
    const arms = page.getByRole("region", { name: "Arms" });
    await expect(arms.getByRole("row", { name: /^ketoconazole/ })).toContainText("Vehicle control (DMSO 0.1%)");
    await expect(arms.getByRole("row", { name: /^montelukast 10 uM minus NADPH/ })).toContainText("Without NADPH");
    await expect(arms.getByRole("row", { name: /^montelukast 10 uM Inhibitor/ })).toContainText("Vehicle control (acetonitrile 0.5%)");
    await page.screenshot({ path: `${screenshots}/20-series-and-controls-setup.png`, fullPage: true });
  });

  await test.step("a block built from the copied template saves with its substrate concentration", async () => {
    await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name: "Bench data" }).click();
    await page.getByRole("button", { name: "Copy template" }).click();
    await expect(page.getByText("Template copied.")).toBeVisible();
    const template = (await page.evaluate(() => navigator.clipboard.readText())).trimEnd().split("\t");
    const labels = [...new Set(template.slice(1).map((column) => column.replace(/ R\d+$/, "")))];
    expect(labels).toEqual([
      "Vehicle control (DMSO 0.1%)",
      "Vehicle control (acetonitrile 0.5%)",
      "ketoconazole",
      "montelukast 0.1 uM",
      "montelukast 1 uM",
      "montelukast 10 uM",
      "montelukast 0.1 uM minus NADPH",
      "montelukast 1 uM minus NADPH",
      "montelukast 10 uM minus NADPH",
      "Minus NADPH",
    ]);
    const rows = TIMEPOINTS.map((minutes) =>
      [
        String(minutes),
        ...template.slice(1).map((column) => percentRemaining(RATES[column.replace(/ R\d+$/, "")] ?? Number.NaN, minutes)),
      ].join("\t"),
    );
    await page.getByLabel("Pasted block").fill([template.join("\t"), ...rows].join("\n"));
    await page.getByRole("textbox", { name: "Substrate concentration", exact: true }).fill("1");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText("180 values read as % of T0.")).toBeVisible();
    await page.getByRole("button", { name: "Save measurements" }).click();
    const confirm = page.getByRole("group", { name: "Save 180 pasted values at 1 µM substrate?" });
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/measurements") && response.request().method() === "PUT",
    );
    await confirm.getByRole("button", { name: "Save measurements" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("Saved 180 measurements.")).toBeVisible();
    await page.screenshot({ path: `${screenshots}/14-bench-data-saved.png`, fullPage: true });
  });

  await test.step("Results reads each arm against its own vehicle", async () => {
    await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name: "Results" }).click();
    const arms: Schemas["Measurements"]["arms"] = (
      await (await request.get(`/api/experiments/${created?.id}/measurements`)).json()
    ).arms;
    const key = (label: string) => {
      const arm = arms.find((candidate) => candidate.label === label);
      if (!arm) throw new Error(`no condition labelled ${label}`);
      return arm.key;
    };
    await expect(page.getByTestId(`clint-${key("Vehicle control (DMSO 0.1%)")}`)).toHaveText(expectedClint(0.03));
    await expect(page.getByTestId(`clint-${key("Vehicle control (acetonitrile 0.5%)")}`)).toHaveText(expectedClint(0.024));
    await expect(page.getByTestId(`clint-${key("ketoconazole")}`)).toHaveText(expectedClint(0.006));
    await expect(page.getByTestId(`reference-${key("montelukast 10 uM")}`)).toHaveText("vs Vehicle control (acetonitrile 0.5%)");
    await expect(page.getByTestId(`reference-${key("montelukast 10 uM minus NADPH")}`)).toContainText("vs Minus NADPH");
    await expect(page.getByTestId(`negative-${key("Minus NADPH")}`)).toContainText("Pass");
    await page.screenshot({ path: `${screenshots}/15-new-experiment-results.png`, fullPage: true });
  });
});
