import { expect, test as setup } from "@playwright/test";
import { SIGNED_IN } from "../playwright.config";
import { E2E_EMAIL, E2E_PASSWORD } from "./accounts";

setup("sign in through the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.context().storageState({ path: SIGNED_IN });
});
