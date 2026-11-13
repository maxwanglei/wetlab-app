import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");

function controls(stage: Locator): Locator {
  return stage.getByRole("group", { name: /^Control: / });
}

/** The brief's first fixture, entered by hand: two stages with a tenfold dilution from 0.5 to 0.05 mg/mL, a
 * gemfibrozil glucuronide series and clopidogrel acyl glucuronide in the primary stage, ketoconazole in the
 * secondary, a vehicle and a minus-NADPH control in each stage, and D3-imatinib as the internal standard. */
test("the gemfibrozil glucuronide design is entered in the form and reads back after a reload", async ({ page, request }) => {
  const reference: Schemas["ReferenceData"] = await (await request.get("/api/reference")).json();
  const lot = (number: string) => {
    const found = reference.reagent_lots.find((candidate) => candidate.lot_number === number);
    if (!found) throw new Error(`the seed has no lot ${number}`);
    return String(found.id);
  };
  await page.goto("/experiments/new");
  await page.getByLabel("Title").fill("Gemfibrozil glucuronide inactivation of CYP2C8 by dilution");
  await page.getByLabel("Study type").selectOption({ label: "Chemical inhibition" });
  await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("amodiaquine");
  const conditions = page.getByRole("region", { name: "Incubation conditions" });
  await conditions.getByLabel("Solvent", { exact: true }).fill("DMSO");
  await conditions.getByLabel("Solvent, final").fill("0.1");

  const components = page.getByRole("region", { name: "Components", exact: true });
  await components.getByRole("button", { name: "Add component" }).click();
  const nadph = components.getByRole("group", { name: /^Component 1/ });
  await nadph.getByRole("textbox", { name: "Component", exact: true }).fill("NADPH");
  await nadph.getByLabel("Role").selectOption("cofactor");

  const primary = page.getByRole("group", { name: /^Primary stage/ });
  await primary.getByLabel("Incubation", { exact: true }).fill("30");
  await primary.getByLabel("Protein", { exact: true }).fill("0.5");
  await primary.getByRole("button", { name: "Add control" }).click();
  await controls(primary).nth(1).getByLabel("Type").selectOption("minus_cofactor");
  await controls(primary).nth(1).getByLabel("Leaves out").selectOption({ label: "NADPH" });

  await page.getByRole("button", { name: "Add stage" }).click();
  const secondary = page.getByRole("group", { name: /^Secondary stage/ });
  await secondary.getByLabel("Dilution from the primary stage").fill("10");
  await secondary.getByLabel("Incubation", { exact: true }).fill("10");
  await secondary.getByLabel("Protein", { exact: true }).fill("0.05");
  await expect(controls(secondary)).toHaveCount(1);
  await secondary.getByRole("button", { name: "Add control" }).click();
  await controls(secondary).nth(1).getByLabel("Type").selectOption("minus_cofactor");
  await controls(secondary).nth(1).getByLabel("Leaves out").selectOption({ label: "NADPH" });

  const standard = page.getByRole("region", { name: "Internal standard" });
  await standard.getByLabel("Compound").fill("D3-imatinib");
  await standard.getByLabel("Concentration", { exact: true }).fill("50");
  await expect(standard.getByLabel("Internal standard unit")).toHaveValue("nM");
  await expect(standard.getByLabel("Added")).toHaveValue("reaction_termination");
  await expect(standard.getByLabel("In", { exact: true })).toHaveValue("ice-cold acetonitrile");

  const addArm = page.getByRole("button", { name: "Add inhibitor arm" });
  await addArm.click();
  const gemfibrozil = page.getByRole("group", { name: /^Arm 1/ });
  await gemfibrozil.getByLabel("Inhibitor").fill("gemfibrozil glucuronide");
  await gemfibrozil.getByLabel("Target enzyme").fill("CYP2C8");
  await gemfibrozil.getByLabel("Concentration 1", { exact: true }).fill("10");
  for (const [index, value] of ["30", "100"].entries()) {
    await gemfibrozil.getByRole("button", { name: "Add concentration" }).click();
    await gemfibrozil.getByLabel(`Concentration ${index + 2}`, { exact: true }).fill(value);
  }
  await addArm.click();
  const clopidogrel = page.getByRole("group", { name: /^Arm 2/ });
  await clopidogrel.getByLabel("Inhibitor").fill("clopidogrel acyl glucuronide");
  await clopidogrel.getByLabel("Target enzyme").fill("CYP2C8");
  await clopidogrel.getByLabel("Concentration 1", { exact: true }).fill("10");
  await addArm.click();
  const ketoconazole = page.getByRole("group", { name: /^Arm 3/ });
  await ketoconazole.getByLabel("Inhibitor").fill("ketoconazole");
  await ketoconazole.getByLabel("Target enzyme").fill("CYP3A4");
  await ketoconazole.getByLabel("Stage it enters").selectOption({ label: "Secondary" });
  await ketoconazole.getByLabel("Concentration 1", { exact: true }).fill("1");
  await ketoconazole.getByLabel("Lot", { exact: true }).selectOption(lot("MTK-25092"));

  await page.getByRole("button", { name: "Add pathway" }).click();
  await page.getByRole("group", { name: /^Pathway 1/ }).getByLabel("Enzyme").fill("CYP2C8");
  await page.screenshot({ path: `${screenshots}/21-gemfibrozil-form.png`, fullPage: true });

  await page.getByRole("button", { name: "Create experiment" }).click();
  await expect(ketoconazole.getByText("MTK-25092 is a lot of montelukast, not ketoconazole.")).toBeVisible();
  await expect(ketoconazole.getByLabel("Lot", { exact: true })).toBeFocused();
  await ketoconazole.getByLabel("Lot", { exact: true }).selectOption(lot("KTZ-25088"));

  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith("/api/experiments") && candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create experiment" }).click();
  const posted = await response;
  expect(posted.status(), await posted.text()).toBe(201);
  const created: Schemas["ExperimentDetail"] = await posted.json();
  expect(created.internal_standard).toMatchObject({ compound: "D3-imatinib", concentration: 50, concentration_unit: "nM" });
  expect(created.arms.map((arm) => arm.label)).toEqual([
    "Vehicle control (primary)",
    "gemfibrozil glucuronide 10 uM (primary)",
    "gemfibrozil glucuronide 30 uM (primary)",
    "gemfibrozil glucuronide 100 uM (primary)",
    "clopidogrel acyl glucuronide (primary)",
    "Minus NADPH (primary)",
    "Vehicle control (secondary)",
    "ketoconazole (secondary)",
    "Minus NADPH (secondary)",
  ]);

  await page.goto(`/experiments/${created.id}/setup`);
  await page.reload();
  await expect(page.getByRole("definition").filter({ hasText: /^30 min, 0\.5 mg\/mL$/ })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "10 min, 0.05 mg/mL, a 10-fold dilution of the primary stage" })).toBeVisible();
  const internal = page.getByTestId("internal-standard");
  await expect(internal).toContainText("D3-imatinib 50 nM");
  await expect(internal).toContainText("At reaction termination, in ice-cold acetonitrile");
  const arms = page.getByRole("region", { name: "Arms" });
  await expect(arms.getByRole("row", { name: /^ketoconazole \(secondary\)/ })).toContainText("Vehicle control (secondary)");
  await expect(arms.getByRole("row", { name: /^gemfibrozil glucuronide 100 uM \(primary\)/ })).toContainText("Vehicle control (primary)");
  const controlTable = page.getByRole("region", { name: "Controls" });
  await expect(controlTable.getByRole("row", { name: /^Minus NADPH \(secondary\)/ })).toContainText("Vehicle control (secondary)");
  await expect(controlTable.getByText("Secondary stage")).toBeVisible();
  const summary = page.getByTestId("design-summary");
  await expect(summary.getByRole("row", { name: /^Primary/ })).toHaveText(/2 inhibitors, 4 conditions\s*1\s*1$/);
  await expect(summary.getByRole("row", { name: /^Secondary/ })).toHaveText(/1 inhibitor\s*1\s*1$/);
  await expect(summary).toContainText("Internal standard: D3-imatinib 50 nM");
  await summary.screenshot({ path: `${screenshots}/26-design-summary.png` });
  await page.screenshot({ path: `${screenshots}/22-gemfibrozil-setup.png`, fullPage: true });
});
