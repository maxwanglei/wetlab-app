import { expect, test, type Page } from "@playwright/test";

function lotRequest(page: Page) {
  return page.waitForResponse(
    (response) => response.url().endsWith("/api/inventory/tissue-lots") && response.request().method() === "POST",
  );
}

test("a pooled HLM lot is added, listed, and offered to a new experiment; its lot number cannot repeat", async ({ page }) => {
  const row = page.getByTestId("tissue-lot-HLM-E2E-0715");

  await test.step("Add tissue lot opens a form with HLM chosen", async () => {
    await page.goto("/inventory/tissue");
    await page.getByRole("link", { name: "Add tissue lot" }).click();
    await expect(page).toHaveURL(/\/inventory\/tissue-lots\/new$/);
    await expect(page.getByLabel("Material type")).toHaveValue("HLM");
    await expect(page.getByLabel("Species")).toHaveValue("human");
    await expect(page.getByLabel("Viability")).toHaveCount(0);
    await page.getByLabel("Pooled or individual").selectOption("pooled");
    await page.getByLabel("Number of donors").fill("50");
    await page.getByLabel("Supplier or source").fill("Corning");
    await page.getByLabel("Lot number").fill("HLM-E2E-0715");
    await page.getByLabel("Protein concentration").fill("20");
    await page.getByLabel("Storage").fill("-80");
  });

  await test.step("saving returns to the Tissue lots tab with the new lot highlighted", async () => {
    const created = lotRequest(page);
    await page.getByRole("button", { name: "Add tissue lot" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      material_type: "HLM",
      species: "human",
      pooled_or_individual: "pooled",
      number_of_donors: 50,
      vendor_or_source: "Corning",
      lot_number: "HLM-E2E-0715",
      protein_concentration: 20,
      storage_temp_c: -80,
    });

    await expect(page).toHaveURL(/\/inventory\/tissue$/);
    await expect(page.getByText("Added lot HLM-E2E-0715.")).toBeVisible();
    await expect(row).toHaveAttribute("data-just-saved", "true");
    await expect(row).toContainText("Corning");
    await expect(row).toContainText("50 donors");
    await expect(row).toContainText("20 mg/mL");
  });

  await test.step("the New experiment form offers the lot", async () => {
    await page.goto("/experiments/new");
    await expect(page.getByLabel("Tissue lot").locator("option", { hasText: "HLM-E2E-0715" })).toHaveCount(1);
  });

  await test.step("the same supplier and lot number again shows the API's message on the form", async () => {
    await page.goto("/inventory/tissue-lots/new");
    await page.getByLabel("Supplier or source").fill("Corning");
    await page.getByLabel("Lot number").fill("HLM-E2E-0715");
    const rejected = lotRequest(page);
    await page.getByRole("button", { name: "Add tissue lot" }).click();
    expect((await rejected).status()).toBe(409);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The lot was not added");
    await expect(alert).toContainText("That lot number already exists for this supplier.");
  });
});
