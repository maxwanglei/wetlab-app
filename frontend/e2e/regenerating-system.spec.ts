import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");

async function addSystem(page: Page, name: string, lot: string, parts: [string, string, string][]) {
  await page.goto("/inventory/reagent-lots/new");
  await page.getByRole("combobox", { name: "Reagent", exact: true }).fill(name);
  await page.getByLabel("Reagent type").selectOption("regenerating_system");
  for (const [index, [component, amount, unit]] of parts.entries()) {
    await page.getByRole("button", { name: "Add component" }).click();
    const row = page.getByRole("group", { name: new RegExp(`^Component ${index + 1}`) });
    await expect(row.getByRole("textbox", { name: "Component", exact: true })).toBeFocused();
    await row.getByRole("textbox", { name: "Component", exact: true }).fill(component);
    await row.getByLabel("Amount").fill(amount);
    await row.getByLabel(`Component ${index + 1} unit`).selectOption(unit);
  }
  await page.getByLabel("Lot number").fill(lot);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/inventory/reagent-lots") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add lot" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const row: Schemas["ReagentLotRow"] = await response.json();
  expect(row.components.map((part) => part.component_name)).toEqual(parts.map(([component]) => component));
  return row;
}

test("Solutions A and B keep their own components, and completing a run asks who prepared its buffer", async ({ page }) => {
  let solutionA: Schemas["ReagentLotRow"] | undefined;
  let solutionB: Schemas["ReagentLotRow"] | undefined;
  await test.step("the inventory records each solution with its components", async () => {
    solutionA = await addSystem(page, "NADPH regenerating system, Solution A", "RGA-E2E", [
      ["NADP+", "1.3", "mM"],
      ["glucose-6-phosphate", "3.3", "mM"],
      ["MgCl2", "3.3", "mM"],
    ]);
    solutionB = await addSystem(page, "NADPH regenerating system, Solution B", "RGB-E2E", [["glucose-6-phosphate dehydrogenase", "0.4", "U/mL"]]);
    await page.goto(`/inventory/reagent-lots/${solutionA.id}/edit`);
    await expect(page.getByRole("region", { name: "Components" })).toContainText("glucose-6-phosphate 3.3 mM");
    await page.screenshot({ path: `${screenshots}/23-regenerating-system-lot.png`, fullPage: true });

    await page.goto("/inventory/reagent-lots/new");
    await page.getByRole("combobox", { name: "Reagent", exact: true }).fill("NADPH regenerating system, Solution A");
    await page.getByRole("button", { name: "Start from lot RGA-E2E's components" }).click();
    await expect(page.getByRole("group", { name: /^Component \d/ })).toHaveCount(3);
    await page.getByLabel("Lot number").fill("RGA-E2E-2");
    const second = page.waitForResponse((response) => response.url().endsWith("/api/inventory/reagent-lots") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Add lot" }).click();
    const secondLot: Schemas["ReagentLotRow"] = await (await second).json();
    expect(secondLot.components.map((part) => part.component_name)).toEqual(["NADP+", "glucose-6-phosphate", "MgCl2"]);
  });

  let experimentId: number | undefined;
  await test.step("an experiment uses both solutions, with a buffer from a solution nobody signed", async () => {
    await page.goto("/experiments/new");
    await page.getByLabel("Title").fill("Midazolam with the NADPH regenerating system");
    await page.getByLabel("Study type").selectOption({ label: "Substrate depletion" });
    await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("midazolam");
    const components = page.getByRole("region", { name: "Components", exact: true });
    const add = components.getByRole("button", { name: "Add component" });
    const row = (n: number) => components.getByRole("group", { name: new RegExp(`^Component ${n}`) });

    await add.click();
    await row(1).getByRole("textbox", { name: "Component", exact: true }).fill("NADPH regenerating system, Solution A");
    await row(1).getByLabel("Role").selectOption("cofactor");
    await row(1).getByLabel("Lot").selectOption(String(solutionA?.id));
    await expect(row(1)).toContainText("NADPH regenerating system, Solution A holds");
    await expect(row(1)).toContainText("NADP+ 1.3 mM");
    await add.click();
    await row(2).getByRole("textbox", { name: "Component", exact: true }).fill("NADPH regenerating system, Solution B");
    await row(2).getByLabel("Role").selectOption("cofactor");
    await row(2).getByLabel("Lot").selectOption(String(solutionB?.id));
    await add.click();
    await row(3).getByRole("textbox", { name: "Component", exact: true }).fill("potassium phosphate buffer");
    await row(3).getByLabel("Role").selectOption("other");
    await row(3).getByLabel("Prepared solution").selectOption("new");
    await row(3).getByLabel("Solution label").fill("100 mM KPi pH 7.4, batch 3");
    await row(3).getByLabel("Buffer composition").fill("100 mM potassium phosphate, pH 7.4");

    const primary = page.getByRole("group", { name: /^Primary stage/ });
    await primary.getByRole("button", { name: "Add control" }).click();
    const negative = primary.getByRole("group", { name: /^Control: / }).nth(1);
    await negative.getByLabel("Type").selectOption("minus_cofactor");
    await expect(negative.getByLabel("Leaves out").locator("option")).toHaveText([
      "Every cofactor",
      "NADPH regenerating system, Solution A",
      "NADPH regenerating system, Solution B",
    ]);
    await page.screenshot({ path: `${screenshots}/24-components-form.png`, fullPage: true });

    const posted = page.waitForResponse((response) => response.url().endsWith("/api/experiments") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create experiment" }).click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    const created: Schemas["ExperimentDetail"] = await response.json();
    experimentId = created.id;
    const minus = created.arms.find((arm) => arm.control_type === "minus_cofactor");
    expect(minus?.label).toBe("Minus all cofactors");
    expect(minus?.omits.map((item) => item.component)).toEqual([
      "NADPH regenerating system, Solution A",
      "NADPH regenerating system, Solution B",
    ]);
    expect(minus?.omits[0]?.contains).toEqual(["NADP+", "glucose-6-phosphate", "MgCl2"]);
  });

  await test.step("the setup tab groups components by role, and completing warns about the unsigned buffer", async () => {
    await page.goto(`/experiments/${experimentId}/setup`);
    await expect(page.getByTestId("components-cofactor")).toContainText("glucose-6-phosphate dehydrogenase 0.4 U/mL");
    await expect(page.getByTestId("components-other")).toContainText("From 100 mM KPi pH 7.4, batch 3, preparer not recorded");
    await page.getByLabel("Status", { exact: true }).selectOption("completed");
    const changed = page.waitForResponse((response) => response.url().endsWith("/status"));
    await page.getByRole("button", { name: "Change status" }).click();
    expect((await changed).status()).toBe(200);
    await expect(page.getByTestId("status-warnings")).toHaveText("100 mM KPi pH 7.4, batch 3 names no preparer. Record who prepared it.");
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: `${screenshots}/25-completed-with-warning.png`, fullPage: true });

    const other = page.getByTestId("components-other");
    await other.getByLabel("Prepared by").selectOption({ label: "Wet Lab Technician" });
    await other.getByRole("button", { name: "Record preparer" }).click();
    await expect(other).toContainText("prepared by Wet Lab Technician");
    await page.getByLabel("Status", { exact: true }).selectOption("qc_passed");
    await page.getByRole("button", { name: "Change status" }).click();
    await expect(page.getByText("QC passed", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("status-warnings")).toHaveCount(0);
  });
});
