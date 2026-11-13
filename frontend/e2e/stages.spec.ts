import { expect, test } from "@playwright/test";

const screenshots = "e2e/screenshots";

test("a two-stage dilution design is entered, saved, and shown again after a reload", async ({ page }) => {
  await page.goto("/experiments/new");
  await page.getByLabel("Title").fill("Gemfibrozil glucuronide inactivation by dilution");
  await page.getByLabel("Study type").selectOption({ label: "Chemical inhibition" });
  await page.getByRole("combobox", { name: "Substrate", exact: true }).fill("amodiaquine");

  const primary = page.getByRole("group", { name: /^Primary stage/ });
  await expect(primary.getByRole("button", { name: /^Remove the \w+ stage$/ })).toHaveCount(0);
  await expect(primary.getByRole("group", { name: "Control: Vehicle control", exact: true })).toBeVisible();
  await primary.getByLabel("Incubation", { exact: true }).fill("30");
  await primary.getByLabel("Protein").fill("0.5");

  await page.getByRole("button", { name: "Add stage" }).click();
  const secondary = page.getByRole("group", { name: /^Secondary stage/ });
  await expect(secondary.getByLabel("Dilution from the primary stage")).toBeFocused();
  await secondary.getByLabel("Dilution from the primary stage").fill("10");
  await secondary.getByLabel("Incubation", { exact: true }).fill("10");
  await secondary.getByLabel("Protein").fill("0.05");
  await expect(secondary.getByText("The dilution gives 0.05 mg/mL.")).toBeVisible();

  await page.getByRole("button", { name: "Add stage" }).click();
  const tertiary = page.getByRole("group", { name: /^Tertiary stage/ });
  await expect(tertiary.getByLabel("Dilution from the secondary stage")).toBeFocused();
  await expect(secondary.getByRole("button", { name: /^Remove the \w+ stage$/ })).toHaveCount(0);
  await tertiary.getByRole("button", { name: "Remove the tertiary stage" }).click();
  await expect(page.getByRole("button", { name: "Add stage" })).toBeFocused();
  await expect(secondary.getByRole("button", { name: "Remove the secondary stage" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/16-two-stage-form.png`, fullPage: true });

  await page.getByRole("button", { name: "Create experiment" }).click();
  await expect(page).toHaveURL(/\/experiments\/\d+\/bench$/);
  await expect(page.getByLabel("Sampled from")).toHaveValue("secondary");
  await page.getByLabel("Sampled from").selectOption("primary");
  await page.getByRole("textbox", { name: "Substrate concentration", exact: true }).fill("1");
  // One vehicle control per stage, three replicates each.
  await page.getByLabel("Pasted block").fill(["0\t100\t100\t100", "5\t90\t91\t92", "10\t80\t81\t82"].map((row) => `${row}\t${row.split("\t").slice(1).join("\t")}`).join("\n"));
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Save measurements" }).click();
  await page.getByRole("group", { name: /^Save 18 pasted values/ }).getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Saved 18 measurements.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Sampled from")).toHaveValue("primary");

  await page.getByRole("link", { name: "Setup" }).click();
  for (const _ of [0, 1]) {
    await expect(page.getByRole("definition").filter({ hasText: /^30 min, 0\.5 mg\/mL$/ })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "10 min, 0.05 mg/mL, a 10-fold dilution of the primary stage" })).toBeVisible();
    await page.reload();
  }
  await page.screenshot({ path: `${screenshots}/17-two-stage-setup.png`, fullPage: true });
});

test("a dilution that disagrees with its entered protein is flagged on the setup tab", async ({ page, request }) => {
  const created = await request.post("/api/experiments", {
    headers: { "X-Requested-With": "wetlab" },
    data: {
      title: "Dilution check",
      study_type: "substrate_depletion",
      substrate: "midazolam",
      stages: [
        { stage_type: "primary", incubation_minutes: 30, protein_concentration: 0.5 },
        { stage_type: "secondary", incubation_minutes: 10, protein_concentration: 0.08, dilution_factor: 10, diluted_from: "primary" },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const experiment = (await created.json()) as { id: number };
  await page.goto(`/experiments/${experiment.id}/setup`);
  await expect(page.getByText("Secondary stage: 0.08 mg/mL entered, but 0.5 mg/mL diluted 10-fold gives 0.05 mg/mL.")).toBeVisible();
  await page.screenshot({ path: `${screenshots}/18-dilution-warning.png`, fullPage: true });
});
