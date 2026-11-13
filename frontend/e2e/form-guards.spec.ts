import { expect, test } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

test("a choice its source no longer supports is shown and refused, never quietly replaced", async ({ page, request }) => {
  await page.goto("/experiments/new");
  const primary = page.getByRole("group", { name: /^Primary stage/ });
  const vehicle = primary.getByRole("group", { name: /^Control: / }).first();
  await vehicle.getByLabel("Solvent", { exact: true }).fill("DMSO");

  await page.getByRole("button", { name: "Add inhibitor arm" }).click();
  const arm = page.getByRole("group", { name: /^Arm 1/ });
  await arm.getByLabel("Inhibitor").fill("ketoconazole");
  await arm.getByLabel("Solvent", { exact: true }).selectOption({ label: "DMSO, as Vehicle control" });

  await test.step("retyping the vehicle leaves the arm's choice visibly stale", async () => {
    await vehicle.getByLabel("Type").selectOption("complete");
    await expect(arm.getByLabel("Solvent", { exact: true }).locator("option:checked")).toHaveText("Choose again: its vehicle changed");
    await page.getByRole("button", { name: "Create experiment" }).click();
    await expect(arm.getByText("Choose the solvent again: the vehicle it came from has changed.")).toBeVisible();
  });

  await test.step("a stage that holds an arm cannot be removed", async () => {
    await page.getByRole("button", { name: "Add stage" }).click();
    await arm.getByLabel("Stage it enters").selectOption({ label: "Secondary" });
    const secondary = page.getByRole("group", { name: /^Secondary stage/ });
    await expect(page.getByRole("button", { name: "Remove the secondary stage" })).toHaveCount(0);
    await expect(secondary.getByText("To remove this stage, move its arms to another stage or remove them.")).toBeVisible();
    await arm.getByLabel("Stage it enters").selectOption({ label: "Primary" });
    await expect(page.getByRole("button", { name: "Remove the secondary stage" })).toBeVisible();
  });

  await test.step("a tiny protein override is labelled in the form as the API labels it", async () => {
    await primary.getByRole("button", { name: "Add control" }).click();
    const killed = primary.getByRole("group", { name: /^Control: / }).nth(1);
    await killed.getByLabel("Type").selectOption("heat_inactivated");
    await killed.getByLabel("Protein override").fill("0.00001");
    const placeholder = await killed.getByLabel("Label", { exact: true }).getAttribute("placeholder");
    const created = await request.post("/api/experiments", {
      headers: { "X-Requested-With": "wetlab" },
      data: {
        title: "Label check",
        study_type: "substrate_depletion",
        substrate: "midazolam",
        controls: [{ control_type: "heat_inactivated", protein_concentration: 0.00001 }],
      },
    });
    const stored: Schemas["ExperimentDetail"] = await created.json();
    expect(placeholder).toBe("Heat-inactivated 1e-05 mg/mL");
    expect(stored.arms[0]?.label).toBe(placeholder);
  });
});
