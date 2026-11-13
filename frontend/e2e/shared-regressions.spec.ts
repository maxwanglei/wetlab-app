import { expect, test } from "@playwright/test";
import type { components } from "../src/api/schema";
import { draftReader } from "../src/lib/drafts";
import * as format from "../src/lib/format";

type Schemas = components["schemas"];
const headers = { "X-Requested-With": "wetlab" };

test("small scientific quantities retain their nonzero magnitude", () => {
  expect(format.quantity(0.0001, "uM")).toBe("0.0001 µM");
  expect(format.plain(1e-12)).toBe("1.00e-12");
  expect(format.plain(-0.0001)).toBe("−0.0001");
  expect(format.plain(0)).toBe("0");
  expect(format.plain(1234.5678)).toBe("1,234.568");
});

test("numeric overflow and underflow cannot silently become missing data or zero", () => {
  for (const text of ["1e309", "-1e309", "1e-999"]) {
    const read = draftReader();
    const value = read.number("quantity_remaining", text);
    expect(read.result({ quantity_remaining: value }).ok).toBe(false);
    expect(read.errors.quantity_remaining).toBeTruthy();
  }
  const read = draftReader();
  expect(read.number("protein", "0,0001")).toBe(0.0001);
  expect(read.number("blank", "")).toBeNull();
  expect(read.number("zero", "0e10")).toBe(0);
  expect(read.errors).toEqual({});
});

test("saving a lot note preserves a colleague's stock update after a background refetch", async ({ page, request }) => {
  const created = await request.post("/api/inventory/reagent-lots", {
    headers,
    data: { reagent_name: "Review stock preservation", lot_number: "STOCK-REGRESSION", quantity_received: 10, quantity_remaining: 10, quantity_unit: "mL" },
  });
  expect(created.status()).toBe(201);
  const lot: Schemas["ReagentLotRow"] = await created.json();
  await page.clock.install();
  await page.goto(`/inventory/reagent-lots/${lot.id}/edit`);
  await page.getByLabel("Notes").fill("Only this note changed");
  expect((await request.patch(`/api/inventory/reagent-lots/${lot.id}`, { headers, data: { quantity_remaining: 2 } })).ok()).toBe(true);
  await page.clock.fastForward(16_000);
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/inventory/reagent-lots") && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await refreshed;
  await page.clock.resume();
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/inventory/reagent-lots/${lot.id}`) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await saved;
  expect(response.request().postDataJSON()).toEqual({ notes: "Only this note changed" });
  const updated: Schemas["ReagentLotRow"] = await response.json();
  expect(updated.quantity_remaining).toBe(2);
});

test("failed sign out keeps the session visible and offers a retry", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Unavailable" }) }));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert")).toContainText("Sign out failed");
  await expect(page).not.toHaveURL(/\/login/);
  expect((await request.get("/api/me")).ok()).toBe(true);
  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("the account page remains reachable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change your password" })).toBeVisible();
});

test("a browser reload warns before discarding a form draft", async ({ page }) => {
  await page.goto("/inventory/reagent-lots/new");
  await page.getByLabel("Lot number").click();
  await page.getByLabel("Lot number").fill("UNSAVED-DRAFT");
  const prompted = page.waitForEvent("dialog");
  const reload = page.reload({ timeout: 5_000 }).catch(() => null);
  const dialog = await prompted;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload;
  await expect(page.getByLabel("Lot number")).toHaveValue("UNSAVED-DRAFT");
});
