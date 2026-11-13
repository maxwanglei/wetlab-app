import { expect, test } from "@playwright/test";

test("tissue provenance stays visible and stock can be depleted and replenished", async ({ page }) => {
  await page.goto("/inventory/tissue-lots/new");
  await page.getByLabel("Supplier or source").fill("Stock regression supplier");
  await page.getByLabel("Lot number").fill("HLM-STOCK-E2E");
  await page.getByLabel("Catalog number").fill("HLM-CATALOG-42");
  await page.getByLabel("Notes").fill("Keep frozen; avoid repeated thawing.");
  await page.getByLabel("Amount remaining").fill("100");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/inventory/tissue-lots") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add tissue lot" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const lotId: unknown = (await response.json()).id;
  expect(typeof lotId).toBe("number");

  await page.getByRole("link", { name: "HLM-STOCK-E2E", exact: true }).click();
  await expect(page.getByText("HLM-CATALOG-42", { exact: true })).toBeVisible();
  await expect(page.getByText("Keep frozen; avoid repeated thawing.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Update stock" }).click();
  await expect(page.getByLabel("Catalog number")).toHaveValue("HLM-CATALOG-42");
  await expect(page.getByLabel("Notes")).toHaveValue("Keep frozen; avoid repeated thawing.");
  await page.getByLabel("Amount remaining").fill("0");
  const emptied = page.waitForResponse((result) => result.url().endsWith(`/api/inventory/tissue-lots/${lotId}`) && result.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes" }).click();
  const empty = await emptied;
  expect(empty.request().postDataJSON()).toEqual({ quantity_remaining: 0 });
  expect(empty.status()).toBe(200);
  await expect(page.getByTestId("tissue-lot-HLM-STOCK-E2E")).toContainText("Depleted");

  await page.getByRole("link", { name: "HLM-STOCK-E2E", exact: true }).click();
  await page.getByRole("link", { name: "Update stock" }).click();
  await expect(page.getByLabel("Used up")).not.toBeChecked();
  await page.getByLabel("Amount remaining").fill("25");
  await page.getByLabel("Used up").check();
  const used = page.waitForResponse((result) => result.url().endsWith(`/api/inventory/tissue-lots/${lotId}`) && result.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await used).status()).toBe(200);
  await expect(page.getByTestId("tissue-lot-HLM-STOCK-E2E")).toContainText("Depleted");

  await page.getByRole("link", { name: "HLM-STOCK-E2E", exact: true }).click();
  await page.getByRole("link", { name: "Update stock" }).click();
  await expect(page.getByLabel("Used up")).toBeChecked();
  await page.getByLabel("Used up").uncheck();
  const replenished = page.waitForResponse((result) => result.url().endsWith(`/api/inventory/tissue-lots/${lotId}`) && result.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await replenished).request().postDataJSON()).toEqual({ is_depleted: false });
  await expect(page.getByTestId("tissue-lot-HLM-STOCK-E2E")).not.toContainText("Depleted");
});
