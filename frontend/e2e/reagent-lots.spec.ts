import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screenshots = path.resolve(import.meta.dirname, "screenshots");

function lotRequest(page: Page, method: "POST" | "PATCH") {
  return page.waitForResponse(
    (response) => response.url().includes("/api/inventory/reagent-lots") && response.request().method() === method,
  );
}

test("a new reagent's lot: added and highlighted, then drawn down and marked used up", async ({ page }) => {
  const row = page.getByTestId("reagent-lot-TCP-26101");

  await test.step("Add lot asks for the reagent's details when the name is new", async () => {
    await page.goto("/inventory/reagents");
    await page.getByRole("link", { name: "Add lot" }).click();
    await expect(page).toHaveURL(/\/inventory\/reagent-lots\/new$/);
    await expect(page.getByLabel("Reagent type")).toHaveCount(0);

    await page.getByRole("combobox", { name: "Reagent", exact: true }).fill("Ticlopidine hydrochloride");
    await expect(page.getByText("A new reagent. Describe it below.")).toBeVisible();
    await page.getByLabel("Reagent type").selectOption("inhibitor");
    await page.getByLabel("Compound").fill("ticlopidine");
    await page.getByLabel("Vendor").fill("Vendor B");
    await page.getByLabel("Catalog number").fill("T-6654");
    await page.getByLabel("Lot number").fill("TCP-26101");
    await page.getByLabel("Concentration", { exact: true }).fill("10");
    await page.getByLabel("Expiry").fill("2027-09-30");
    await page.getByLabel("Storage").fill("-20");
    await page.getByLabel("Amount received").fill("1");
    await page.screenshot({ path: `${screenshots}/07-add-reagent-lot.png`, fullPage: true });
  });

  await test.step("saving returns to the list with the new lot highlighted; an empty remaining amount means unopened", async () => {
    const created = lotRequest(page, "POST");
    await page.getByRole("button", { name: "Add lot" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      reagent_name: "Ticlopidine hydrochloride",
      reagent_type: "inhibitor",
      compound_name: "ticlopidine",
      vendor: "Vendor B",
      catalog_number: "T-6654",
      lot_number: "TCP-26101",
      concentration: 10,
      concentration_unit: "mM",
      expiry_date: "2027-09-30",
      storage_temp_c: -20,
      quantity_received: 1,
      quantity_remaining: 1,
      quantity_unit: "mL",
    });

    await expect(page).toHaveURL(/\/inventory\/reagents$/);
    await expect(page.getByText("Added lot TCP-26101 of Ticlopidine hydrochloride.")).toBeVisible();
    await expect(row).toHaveAttribute("data-just-saved", "true");
    await expect(row).toContainText("Just added");
    await expect(row).toContainText("1 of 1 mL");
    await expect(row).toContainText("None");
    await page.screenshot({ path: `${screenshots}/08-new-lot-highlighted.png`, fullPage: true });
  });

  await test.step("the same lot number again shows the API's message on the form", async () => {
    await page.getByRole("link", { name: "Add lot" }).click();
    await page.getByRole("combobox", { name: "Reagent", exact: true }).fill("ticlopidine hydrochloride");
    await expect(page.getByText("Adds a lot of Ticlopidine hydrochloride, inhibitor.")).toBeVisible();
    await expect(page.getByLabel("Reagent type")).toHaveCount(0);
    await page.getByLabel("Lot number").fill("TCP-26101");
    const rejected = lotRequest(page, "POST");
    await page.getByRole("button", { name: "Add lot" }).click();
    expect((await rejected).status()).toBe(409);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The lot was not added");
    await expect(alert).toContainText("That lot number already exists for this reagent.");
    await expect(alert).toBeFocused();
    await page.screenshot({ path: `${screenshots}/09-duplicate-lot.png` });

    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page.getByText("The new lot is not saved.")).toBeVisible();
    await page.getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/inventory\/reagents$/);
  });

  await test.step("Edit sends only the remaining amount, and the lot is flagged low stock", async () => {
    await row.getByRole("link", { name: "Edit lot TCP-26101" }).click();
    await expect(page.getByRole("heading", { name: "Edit lot TCP-26101" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await page.getByLabel("Amount remaining").fill("0.1");
    const updated = lotRequest(page, "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    const response = await updated;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ quantity_remaining: 0.1 });

    await expect(page).toHaveURL(/\/inventory\/reagents$/);
    await expect(row).toContainText("Just saved");
    await expect(row).toContainText("0.1 of 1 mL");
    await expect(row).toContainText("Low stock, 10% left");
  });

  await test.step("marking it used up replaces the low-stock flag with Depleted", async () => {
    await row.getByRole("link", { name: "Edit lot TCP-26101" }).click();
    await page.getByLabel("Used up").check();
    await page.screenshot({ path: `${screenshots}/10-edit-lot-used-up.png`, fullPage: true });
    const updated = lotRequest(page, "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await updated).request().postDataJSON()).toEqual({ is_depleted: true });

    await expect(row).toContainText("Depleted");
    await expect(row).not.toContainText("Low stock");
    await page.screenshot({ path: `${screenshots}/11-lot-depleted.png`, fullPage: true });
  });
});
