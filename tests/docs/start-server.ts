/**
 * Started by playwright.docs.config.ts: clears the tutorial's data and starts the
 * server with its clock set to the tutorial's date. Test harness only.
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TUTORIAL_NOW } from "./now.js";

const here = path.dirname(fileURLToPath(import.meta.url));
rmSync(path.join(here, ".tmp"), { recursive: true, force: true });
if (!process.env.DOCS_IMAGES_CLIENT_BUILT)
  execSync("npm run build -w @planning/client", {
    cwd: path.resolve(here, "../.."),
    stdio: "inherit",
  });

const RealDate = Date;
const offset = new RealDate(TUTORIAL_NOW).getTime() - RealDate.now();
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [string]));
  }
  static override now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate as DateConstructor;

process.env.PLANNING_CONFIG = path.join(here, "config.docs.json");
await import("../../server/src/index.js");
