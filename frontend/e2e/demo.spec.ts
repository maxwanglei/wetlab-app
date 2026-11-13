import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "../src/api/schema";

type Depletion = components["schemas"]["DepletionResult"];

const screenshots = path.resolve(import.meta.dirname, "screenshots");

/** The sample's vehicle, found by kind and label: arm keys carry database ids, which a reseed can change. */
function controlArm(result: Depletion) {
  const control = result.arms.find((arm) => arm.kind === "control" && arm.label === "Vehicle control");
  if (!control) throw new Error("the depletion result has no vehicle control arm");
  return control;
}

/** Screen position of a data point, read from Plotly's own axis mapping (a private API, test-only). */
async function plotPosition(page: Page, time: number, percent: number) {
  return page.evaluate(
    ({ time, percent }) => {
      type Axis = { _offset: number; d2p: (value: number) => number };
      const plot = document.querySelector(".js-plotly-plot");
      if (!plot || !("_fullLayout" in plot)) throw new Error("the depletion plot has not rendered");
      const { xaxis, yaxis } = plot._fullLayout as { xaxis: Axis; yaxis: Axis };
      const box = plot.getBoundingClientRect();
      return { x: box.left + xaxis._offset + xaxis.d2p(time), y: box.top + yaxis._offset + yaxis.d2p(percent) };
    },
    { time, percent },
  );
}

test("WL-2026-047: from the lot alert to a saved, re-fitted exclusion", async ({ page, request }) => {
  await test.step("the dashboard flags ketoconazole lot KTZ-25088", async () => {
    await page.goto("/");
    const alert = page.getByTestId("lot-alert-KTZ-25088");
    await expect(alert).toContainText("Ketoconazole");
    await expect(alert).toContainText(/Expires in \d+ days?|Expires today|Expired/);
    await page.screenshot({ path: `${screenshots}/01-dashboard.png`, fullPage: true });
  });

  await test.step("the Setup tab lists quinidine as a selectivity control", async () => {
    await page.getByRole("link", { name: "WL-2026-047" }).click();
    await expect(page).toHaveURL(/\/experiments\/\d+\/setup$/);
    const quinidine = page.getByRole("row", { name: /quinidine/ });
    await expect(quinidine).toContainText("Selectivity control");
    await expect(quinidine).toContainText("CYP2D6");
    await page.screenshot({ path: `${screenshots}/02-setup.png`, fullPage: true });
  });

  const experimentId = /\/experiments\/(\d+)\//.exec(page.url())?.[1];
  expect(experimentId, "the Setup URL carries the experiment id").toBeTruthy();
  const seeded: Depletion = await (await request.get(`/api/experiments/${experimentId}/depletion`)).json();
  const outlier = controlArm(seeded).points.find((point) => point.replicate === 3 && point.timepoint === 60);
  if (!outlier) throw new Error("the seed has no control replicate 3 at 60 min");
  expect(outlier.excluded, "the seed starts with the outlier included").toBe(false);
  expect(controlArm(seeded).fit.clint_app).toBeCloseTo(49.6, 1);
  const vehicleClint = page.getByTestId(`clint-${controlArm(seeded).key}`);

  await test.step("Results opens with the outlier included: control CLint,app 49.6", async () => {
    await page.getByRole("navigation", { name: "Experiment sections" }).getByRole("link", { name: "Results" }).click();
    await expect(vehicleClint).toHaveText("49.6");
    await expect(page.getByText("Not saved yet")).toBeVisible();
    await expect(page.locator(".js-plotly-plot .scatterlayer .trace").first()).toBeVisible();
    await page.screenshot({ path: `${screenshots}/03-results-with-outlier.png`, fullPage: true });
  });

  await test.step("on the plot, the outlier asks for a reason, refits when excluded, and comes back when clicked again", async () => {
    const position = await plotPosition(page, outlier.timepoint, outlier.percent_of_t0);
    await page.mouse.click(position.x, position.y);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Vehicle control R3, 60 min");
    await expect(dialog.getByRole("button", { name: "Exclude point" })).toBeDisabled();
    await dialog.getByRole("radio", { name: "Carryover" }).check();
    await expect(dialog.getByRole("button", { name: "Exclude point" })).toBeEnabled();
    await page.screenshot({ path: `${screenshots}/04-plot-reason-popover.png` });
    await dialog.getByRole("button", { name: "Exclude point" }).click();
    await expect(vehicleClint).toHaveText("56.0");

    await page.mouse.click(position.x, position.y);
    await expect(vehicleClint).toHaveText("49.6");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("in the Points list, excluding control R3 at 60 min for carryover refits CLint,app to 56.0", async () => {
    await page.getByRole("button", { name: /^Points/ }).click();
    const row = page.getByTestId(`point-${outlier.measurement_id}`);
    const preview = page.waitForResponse(
      (response) => response.url().endsWith("/depletion/preview") && response.request().method() === "POST",
    );
    await row.getByRole("checkbox").check();
    const previewResponse = await preview;
    expect(previewResponse.request().postDataJSON()).toEqual({ excluded_ids: [outlier.measurement_id] });
    const refit: Depletion = await previewResponse.json();
    expect(controlArm(refit).fit.clint_app).toBeCloseTo(56.0, 1);

    await expect(page.getByText("Choose a reason for 1 excluded point")).toBeVisible();
    await expect(page.getByTestId("save-results")).toBeDisabled();
    await row.getByRole("combobox").selectOption("carryover");
    await expect(vehicleClint).toHaveText("56.0");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/05-results-outlier-excluded.png`, fullPage: true });
  });

  await test.step("Save records the exclusion with its reason", async () => {
    const save = page.waitForResponse((response) => response.url().endsWith("/depletion/save"));
    await page.getByTestId("save-results").click();
    const saveResponse = await save;
    expect(saveResponse.status()).toBe(200);
    expect(saveResponse.request().postDataJSON()).toEqual({
      exclusions: [{ measurement_id: outlier.measurement_id, reason: "carryover" }],
    });
    await expect(page.getByText("Saved with 1 exclusion")).toBeVisible();
    await expect(page.getByText(/^Last saved .+ by /)).toBeVisible();
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
  });

  await test.step("after a reload the point is still excluded for carryover", async () => {
    await page.reload();
    await expect(vehicleClint).toHaveText("56.0");
    await page.getByRole("button", { name: /^Points/ }).click();
    const row = page.getByTestId(`point-${outlier.measurement_id}`);
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(row.getByRole("combobox")).toHaveValue("carryover");
    await page.screenshot({ path: `${screenshots}/06-results-after-reload.png`, fullPage: true });

    const stored: Depletion = await (await request.get(`/api/experiments/${experimentId}/depletion`)).json();
    const storedOutlier = controlArm(stored).points.find((point) => point.measurement_id === outlier.measurement_id);
    expect(storedOutlier).toMatchObject({ excluded: true, exclusion_reason: "carryover" });
    expect(stored.saved).not.toBeNull();
    expect(controlArm(stored).fit.clint_app).toBeCloseTo(56.0, 1);
  });
});
