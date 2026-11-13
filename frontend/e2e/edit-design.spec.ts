import { expect, test } from "@playwright/test";
import type { Schemas } from "../src/api/client";

const FETCH = { "X-Requested-With": "wetlab" };

/** The design new-experiment.spec.ts enters in the form, as the form sends it, with a second target for
 * ketoconazole: two vehicles, a minus-NADPH control, ketoconazole, and a montelukast series also run without NADPH. */
function formDesign(): Schemas["ExperimentIn"] {
  const shared = { role: "inhibitor", concentration_unit: "uM", stage: "primary", reagent_lot_id: null, reference_control: null, replicates: 3 } as const;
  const montelukast = (concentration: number, omitted: boolean) => ({
    ...shared,
    inhibitor: "montelukast",
    target_enzyme: "CYP2C8",
    also_targets: [],
    solvent: "acetonitrile",
    solvent_percentage: 0.5,
    concentration,
    cofactor_omitted: omitted,
    omitted_cofactor: omitted ? 0 : null,
  });
  return {
    title: "A design to edit in the form",
    study_type: "chemical_inhibition",
    substrate: "amodiaquine",
    sampling: "time_course",
    condition: { incubation_temperature: 37, solvent: "DMSO", solvent_percentage: 0.1 },
    stages: [{ stage_type: "primary", incubation_minutes: 60, protein_concentration: 0.5, dilution_factor: null, diluted_from: null }],
    cofactors: [{ cofactor: "NADPH", role: "cofactor", concentration: 1, concentration_unit: "mM", solution: null }],
    controls: [
      { stage: "primary", control_type: "vehicle", label: null, solvent: "DMSO", solvent_percentage: 0.1, omitted_cofactor: null, replicates: 3 },
      { stage: "primary", control_type: "vehicle", label: null, solvent: "acetonitrile", solvent_percentage: 0.5, omitted_cofactor: null, replicates: 3 },
      { stage: "primary", control_type: "minus_cofactor", label: null, solvent: null, omitted_cofactor: 0, protein_concentration: null, replicates: 3 },
    ],
    arms: [
      { ...shared, inhibitor: "ketoconazole", target_enzyme: "CYP3A4", also_targets: ["CYP3A5"], solvent: "DMSO", solvent_percentage: 0.1, concentration: 1, cofactor_omitted: false, omitted_cofactor: null },
      ...[0.1, 1, 10].map((c) => montelukast(c, false)),
      ...[0.1, 1, 10].map((c) => montelukast(c, true)),
    ],
    pathways: [{ enzyme: "CYP3A4", pathway_role: "major", organ_context: "hepatic" }],
    internal_standard: null,
  };
}

test("a planned design is changed in the form, and one with bench data keeps its design", async ({ page, request }) => {
  const created: Schemas["ExperimentDetail"] = await (
    await request.post("/api/experiments", { data: formDesign(), headers: FETCH })
  ).json();

  await page.goto(`/experiments/${created.id}/setup`);
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/experiments/${created.id}/edit$`));
  const first = page.getByRole("group", { name: /^Arm 1/ });
  const second = page.getByRole("group", { name: /^Arm 2/ });
  await expect(first.getByLabel("Inhibitor")).toHaveValue("ketoconazole");
  await expect(first.getByLabel(/^Also target 1/)).toHaveValue("CYP3A5");
  await expect(second.getByLabel("Inhibitor")).toHaveValue("montelukast");
  await expect(second.getByLabel("Concentration 3", { exact: true })).toHaveValue("10");
  await expect(second.getByLabel("Also run each concentration without a cofactor")).toBeChecked();

  await first.getByLabel("Inhibitor").fill("itraconazole");
  await page.getByRole("button", { name: "Add inhibitor arm" }).click();
  const added = page.getByRole("group", { name: /^Arm 3/ });
  await added.getByLabel("Inhibitor").fill("quinidine");
  await added.getByLabel("Target enzyme").fill("CYP2D6");
  await added.getByLabel("Concentration 1", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/experiments/${created.id}/setup$`));
  const arms = page.getByRole("region", { name: /^Arms/ });
  await page.reload();
  await expect(arms).toContainText("itraconazole");
  await expect(arms).toContainText("CYP3A4, CYP3A5");
  await expect(arms).toContainText("quinidine");
  await expect(arms).not.toContainText("ketoconazole");
  await expect(arms).toContainText("montelukast");

  const story = (await (await request.get("/api/experiments")).json()).find(
    (experiment: Schemas["ExperimentSummary"]) => experiment.code === "WL-2026-047",
  );
  await page.goto(`/experiments/${story.id}/setup`);
  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page.getByText("Bench data has been pasted against this design")).toBeVisible();
  await expect(page.getByRole("group", { name: /^Arm 1/ })).toHaveCount(0);
  await page.getByLabel("Title").fill("Tucatinib phenotyping, renamed");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tucatinib phenotyping, renamed");
});
