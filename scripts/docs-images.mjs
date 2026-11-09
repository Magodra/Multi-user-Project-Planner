/**
 * Regenerates the tutorial's pictures with Playwright. Called by `npm run build`,
 * which skips it (keeping the committed pictures) when SKIP_DOCS_IMAGES is set
 * or no Chromium is installed, so servers can build without a browser.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const fromBuild = process.argv.includes("--from-build");
const skip = (why) => {
  console.warn(`Tutorial pictures not regenerated: ${why}`);
  process.exit(0);
};

if (fromBuild && process.env.SKIP_DOCS_IMAGES) skip("SKIP_DOCS_IMAGES is set.");
if (fromBuild && !existsSync(chromium.executablePath()))
  skip("no Chromium found (npx playwright install chromium).");

const { status } = spawnSync("npx playwright test -c playwright.docs.config.ts", {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, ...(fromBuild ? { DOCS_IMAGES_CLIENT_BUILT: "1" } : {}) },
});
process.exit(status ?? 1);
