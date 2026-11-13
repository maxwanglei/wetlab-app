import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { components } from "../src/api/schema";

type Schemas = components["schemas"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");
const FETCH = { "X-Requested-With": "wetlab" };
const TIMEPOINTS = [0, 5, 15, 30, 45, 60];

/** First-order rates (per min) each condition follows exactly. Zero is a flat negative control; minus all
 * cofactors keeps 78.7% at 60 min, just under the 80% a negative needs to pass. */
const RATES: Record<string, number> = {
  "Vehicle control (DMSO 0.1%)": 0.03,
  "Vehicle control (acetonitrile 0.5%)": 0.024,
  ketoconazole: 0.006,
  montelukast: 0.012,
  "Minus NADPH": 0,
  "Minus UDPGA": 0.0005,
  "Minus all cofactors": 0.004,
};

test("several controls in one stage: each inhibitor reads against the vehicle in its own solvent", async ({ page, request }) => {
  const created = await request.post("/api/experiments", {
    headers: FETCH,
    data: {
      title: "Amodiaquine with two vehicles and a negative panel",
      study_type: "chemical_inhibition",
      substrate: "amodiaquine",
      stages: [{ stage_type: "primary", incubation_minutes: 60, protein_concentration: 0.5 }],
      condition: { solvent: "DMSO", solvent_percentage: 0.1 },
      cofactors: [
        { cofactor: "NADPH", role: "cofactor", concentration: 1, concentration_unit: "mM" },
        { cofactor: "UDPGA", role: "cofactor", concentration: 2, concentration_unit: "mM" },
      ],
      controls: [
        { control_type: "vehicle", solvent: "DMSO", solvent_percentage: 0.1 },
        { control_type: "vehicle", solvent: "acetonitrile", solvent_percentage: 0.5 },
        { control_type: "minus_cofactor", omitted_cofactor: 0 },
        { control_type: "minus_cofactor", omitted_cofactor: 1 },
        { control_type: "minus_cofactor" },
      ],
      arms: [
        { inhibitor: "ketoconazole", target_enzyme: "CYP3A4", concentration: 1 },
        { inhibitor: "montelukast", target_enzyme: "CYP2C8", concentration: 2, solvent: "acetonitrile" },
      ],
      pathways: [
        { enzyme: "CYP3A4", pathway_role: "major" },
        { enzyme: "CYP2C8", pathway_role: "major" },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const experiment: Schemas["ExperimentDetail"] = await created.json();
  const key = (label: string) => {
    const arm = experiment.arms.find((candidate) => candidate.label === label);
    if (!arm) throw new Error(`the experiment has no condition labelled ${label}`);
    return arm.key;
  };
  const rows = experiment.arms.flatMap((arm) =>
    [1, 2, 3].flatMap((replicate) =>
      TIMEPOINTS.map((timepoint) => ({
        arm_key: arm.key,
        replicate,
        timepoint,
        percent_of_t0: 100 * Math.exp(-(RATES[arm.label] ?? Number.NaN) * timepoint),
      })),
    ),
  );
  const pasted = await request.put(`/api/experiments/${experiment.id}/measurements`, {
    headers: FETCH,
    data: { rows, substrate_concentration: 1 },
  });
  expect(pasted.status()).toBe(200);

  await page.goto(`/experiments/${experiment.id}/results`);

  await test.step("each vehicle has its own readout", async () => {
    const dmso = page.getByTestId(`readout-${key("Vehicle control (DMSO 0.1%)")}`);
    const acetonitrile = page.getByTestId(`readout-${key("Vehicle control (acetonitrile 0.5%)")}`);
    await expect(dmso).toContainText("60.0");
    await expect(acetonitrile).toContainText("48.0");
    await expect(dmso).toContainText("Minus all cofactors lost parent: 78.6% left at 60 min");
    await expect(acetonitrile).not.toContainText("lost parent");
  });

  await test.step("each inhibitor names its reference and is inhibited against it", async () => {
    await expect(page.getByTestId(`reference-${key("ketoconazole")}`)).toHaveText("vs Vehicle control (DMSO 0.1%)");
    await expect(page.getByTestId(`reference-${key("montelukast")}`)).toHaveText("vs Vehicle control (acetonitrile 0.5%)");
    await expect(page.getByTestId(`clint-${key("ketoconazole")}`)).toHaveText("12.0");
    const table = page.getByRole("region", { name: "Per-arm results" });
    await expect(table.getByRole("row", { name: /ketoconazole/ })).toContainText("80.0");
    await expect(table.getByRole("row", { name: /montelukast/ })).toContainText("50.0");
  });

  await test.step("flat negatives pass, and the one that lost parent is a check, not a problem", async () => {
    await expect(page.getByTestId(`negative-${key("Minus NADPH")}`)).toContainText("Pass");
    await expect(page.getByTestId(`negative-${key("Minus UDPGA")}`)).toContainText("Pass");
    await expect(page.getByTestId(`negative-${key("Minus all cofactors")}`)).toContainText("Lost parent");
    await expect(page.getByTestId("checks")).toHaveText("Minus all cofactors: 78.6% remaining at 60 min (threshold 80%)");
    await expect(page.getByText("None reported for this fit.")).toBeVisible();
    await page.screenshot({ path: `${screenshots}/19-multi-control-results.png`, fullPage: true });
  });

  await test.step("the CSV download has a row per measurement, each naming its reference", async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${experiment.code}-measurements.csv`);
    const text = (await readFile(await file.path())).toString("utf-8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split("\r\n");
    const header = lines[0]?.split(",") ?? [];
    expect(lines).toHaveLength(1 + rows.length);
    const label = header.indexOf("series_label");
    const referenceLabel = header.indexOf("reference_label");
    const ketoconazole = lines.find((line) => line.split(",")[label] === "ketoconazole");
    expect(ketoconazole?.split(",")[referenceLabel]).toBe("Vehicle control (DMSO 0.1%)");
  });
});
