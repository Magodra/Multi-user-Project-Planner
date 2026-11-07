import { describe, expect, it } from "vitest";
import { retryWhileBusy } from "./locks.js";

const busy = (code: string) => Object.assign(new Error(code), { code });

describe("retryWhileBusy", () => {
  it("retries while a file is busy (e.g. held by Dropbox), then succeeds", async () => {
    let calls = 0;
    const result = await retryWhileBusy(async () => {
      calls++;
      if (calls < 3) throw busy(calls === 1 ? "EBUSY" : "EPERM");
      return "done";
    }, 1_000);
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      retryWhileBusy(async () => {
        calls++;
        throw busy("ENOENT");
      }, 1_000),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("gives up after the wait time", async () => {
    await expect(
      retryWhileBusy(async () => {
        throw busy("EBUSY");
      }, 50),
    ).rejects.toThrow("EBUSY");
  });
});
