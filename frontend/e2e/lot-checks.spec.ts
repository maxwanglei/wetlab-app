import { expect, test } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

test("a lot whose reagent names no compound saves with a note that linking the compound clears", async ({ page, request }) => {
  const added = await request.post("/api/inventory/reagent-lots", {
    headers: { "X-Requested-With": "wetlab" },
    data: { reagent_name: "KTZ hydrochloride, vendor C", reagent_type: "inhibitor", lot_number: "KC-E2E" },
  });
  const lot: Schemas["ReagentLotRow"] = await added.json();

  await page.goto("/experiments/new");
  await page.getByLabel("Title").fill("Ketoconazole from a new vendor");
  await page.getByLabel("Study type").selectOption({ label: "Chemical inhibition" });
  await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("midazolam");
  await page.getByRole("button", { name: "Add inhibitor arm" }).click();
  const arm = page.getByRole("group", { name: /^Arm 1/ });
  await arm.getByLabel("Inhibitor").fill("ketoconazole");
  await arm.getByLabel("Lot", { exact: true }).selectOption(String(lot.id));
  await page.getByRole("button", { name: "Create experiment" }).click();

  const note = "ketoconazole arm: lot KC-E2E (KTZ hydrochloride, vendor C) names no compound, so it was not checked against ketoconazole.";
  await expect(page.getByTestId("planned-warnings")).toContainText(note);
  const experimentUrl = page.url().replace(/\/bench$/, "");

  await page.goto(`/inventory/reagent-lots/${lot.id}/edit`);
  await page.getByRole("region", { name: "Reagent" }).getByLabel("Compound").fill("ketoconazole");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/inventory\/reagents$/);

  await page.goto(`${experimentUrl}/setup`);
  await expect(page.getByTestId("design-summary")).not.toContainText("names no compound");
});
