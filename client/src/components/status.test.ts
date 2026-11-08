import { describe, expect, it } from "vitest";
import { itemBadges } from "./status";

const base = {
  external: false,
  recipients: [],
  reference: false,
  linkType: null,
  pending: false,
  agreementState: "NONE" as const,
  endVarianceDays: null,
};

describe("itemBadges", () => {
  it("shows nothing for a plain internal task", () => {
    expect(itemBadges(base)).toEqual([]);
  });

  it("marks references with their link type and external tasks with recipients", () => {
    expect(
      itemBadges({ ...base, reference: true, linkType: "AGREEMENT" }).map((b) => b.label),
    ).toEqual(["REF", "AGR"]);
    expect(
      itemBadges({ ...base, reference: true, linkType: "MONITOR" }).map((b) => b.label),
    ).toEqual(["REF", "MON"]);
    const ext = itemBadges({
      ...base,
      external: true,
      recipients: [
        { name: "Customer", linkType: "MONITOR" },
        { name: "Site (Sub)", linkType: "MONITOR" },
      ],
    });
    expect(ext[0]?.title).toBe("External task used in 2 other plan(s):\n• Customer\n• Site (Sub)");
    expect(ext.map((b) => b.label)).toEqual(["EXT 2", "MON"]);
  });

  it("shows the owner plan the type of each use, with the plans of that type", () => {
    const mixed = itemBadges({
      ...base,
      external: true,
      recipients: [
        { name: "Customer", linkType: "AGREEMENT" },
        { name: "Site", linkType: "MONITOR" },
        { name: "Partner", linkType: "AGREEMENT" },
      ],
    });
    expect(mixed.map((b) => b.label)).toEqual(["EXT 3", "AGR", "MON"]);
    expect(mixed[1]?.title).toBe(
      "AGREEMENT link: changes need approval of all parties\n• Customer\n• Partner",
    );
    expect(mixed[2]?.title).toBe("MONITOR link: changes are notified\n• Site");
  });

  it("shows no link type for an external task no plan uses yet", () => {
    expect(itemBadges({ ...base, external: true }).map((b) => b.label)).toEqual(["EXT"]);
  });

  it("shows pending, rejected and variance against agreed", () => {
    const labels = itemBadges({
      ...base,
      pending: true,
      agreementState: "REJECTED",
      endVarianceDays: 3,
    }).map((b) => b.label);
    expect(labels).toEqual(["PEND", "REJ", "+3d"]);
    expect(itemBadges({ ...base, endVarianceDays: -2 })[0]?.className).toBe("pp-b-early");
  });
});
