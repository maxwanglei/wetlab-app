import { expect, test } from "@playwright/test";

test("removing a middle arm keeps the other arms, clears the arms' problems, and returns focus to Add", async ({ page }) => {
  await page.goto("/experiments/new");
  const addArm = page.getByRole("button", { name: "Add inhibitor arm" });
  const arm = (position: number) => page.getByRole("group", { name: new RegExp(`^Arm ${position}\\b`) });

  for (const [index, inhibitor] of ["montelukast", "", "quinidine"].entries()) {
    await addArm.click();
    await expect(arm(index + 1).getByLabel("Inhibitor")).toBeFocused();
    if (inhibitor) await arm(index + 1).getByLabel("Inhibitor").fill(inhibitor);
  }

  await page.getByRole("button", { name: "Create experiment" }).click();
  await expect(arm(2).getByLabel("Inhibitor")).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("button", { name: "Remove arm 2" }).click();
  await expect(addArm).toBeFocused();
  await expect(page.getByRole("group", { name: /^Arm \d/ })).toHaveCount(2);
  await expect(arm(1).getByLabel("Inhibitor")).toHaveValue("montelukast");
  await expect(arm(2).getByLabel("Inhibitor")).toHaveValue("quinidine");
  await expect(arm(2).getByLabel("Inhibitor")).not.toHaveAttribute("aria-invalid", "true");
});
