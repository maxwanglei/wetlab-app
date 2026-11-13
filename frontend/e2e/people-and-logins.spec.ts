import { expect, test, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./accounts";

test.use({ storageState: { cookies: [], origins: [] } });

const GRACE = { name: "Grace Example", email: "grace.e2e@example.org", first: "grace first password", next: "grace second password" };

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test("an admin adds a person, who signs in, changes their password, and is turned off", async ({ page, browser }) => {
  await page.goto("/experiments");
  await expect(page).toHaveURL(/\/login\?next=%2Fexperiments$/);

  await signIn(page, E2E_EMAIL, "not the password");
  await expect(page.getByRole("alert")).toContainText("Email or password is wrong.");

  await signIn(page, E2E_EMAIL, E2E_PASSWORD);
  await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();

  await page.getByRole("link", { name: "People" }).click();
  await page.getByLabel("Name", { exact: true }).fill(GRACE.name);
  await page.getByLabel("Email", { exact: true }).fill(GRACE.email);
  await page.getByLabel("Role", { exact: true }).fill("technician");
  await page.getByLabel(/First password/).fill(GRACE.first);
  await page.getByRole("button", { name: "Add person" }).click();
  const graceRow = page.getByRole("row").filter({ hasText: GRACE.email });
  await expect(graceRow).toContainText("Can sign in");
  await signOut(page);

  const grace = await (await browser.newContext()).newPage();
  await grace.goto("/");
  await signIn(grace, GRACE.email, GRACE.first);
  await expect(grace.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(grace.getByRole("link", { name: "People" })).toHaveCount(0);
  await grace.getByRole("link", { name: GRACE.name }).click();
  await grace.getByLabel("Current password").fill(GRACE.first);
  await grace.getByLabel("New password", { exact: true }).fill(GRACE.next);
  await grace.getByLabel("New password again").fill(GRACE.next);
  await grace.getByRole("button", { name: "Change password" }).click();
  await expect(grace.getByRole("status")).toHaveText("Password changed.");

  await signIn(page, E2E_EMAIL, E2E_PASSWORD);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("link", { name: "People" }).click();
  await page.getByRole("button", { name: `Change ${GRACE.name}` }).click();
  await page.getByLabel(/^Active/).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(graceRow).toContainText("Turned off");

  await grace.reload();
  await expect(grace).toHaveURL(/\/login\?next=/);
  await signIn(grace, GRACE.email, GRACE.next);
  await expect(grace.getByRole("alert")).toContainText("Email or password is wrong.");
});
