import { defineConfig, devices } from "@playwright/test";

// Generates docs/images/tutorial/*.png (npm run docs:images); not part of the e2e suite.
export default defineConfig({
  testDir: "tests/docs",
  testMatch: "*.images.ts",
  workers: 1,
  reporter: "list",
  outputDir: "tests/docs/.tmp/results",
  webServer: {
    command: "npx tsx --conditions=source tests/docs/start-server.ts",
    url: "http://localhost:8182/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:8182/index.html",
    viewport: { width: 1360, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
  },
});
