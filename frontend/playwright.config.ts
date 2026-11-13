import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:5173";
const backend = path.resolve(import.meta.dirname, "../backend");
/** The signed-in session every spec starts from, saved by e2e/auth.setup.ts. */
export const SIGNED_IN = path.resolve(import.meta.dirname, "e2e/.auth/signed-in.json");

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "sign in", testMatch: /auth\.setup\.ts/ },
    { name: "app", dependencies: ["sign in"], use: { storageState: SIGNED_IN } },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : [
        {
          command: "uv run uvicorn app.main:app --port 8000",
          cwd: backend,
          url: "http://localhost:8000/api/health",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        { command: "npm run dev", url: baseURL, reuseExistingServer: true, timeout: 120_000 },
      ],
});
