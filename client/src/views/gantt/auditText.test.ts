import { describe, expect, it } from "vitest";
import type { AuditLogEntry, TaskHistory } from "@planning/shared";
import { describeAuditEntry } from "./auditText";

const entry = (fields: Partial<AuditLogEntry>): AuditLogEntry =>
  ({
    id: "1",
    entityType: "task",
    entityId: "t",
    action: "update",
    origin: "UI",
    details: {},
    ...fields,
  }) as AuditLogEntry;

const history: TaskHistory = {
  entries: [],
  requests: {
    cr: {
      title: "Change: Delivery",
      kind: "PROPOSE_TASK_CHANGE",
      description: "Supplier delay",
      planName: "Supplier",
      proposed: {
        itemId: "t",
        name: "Delivery",
        parentId: null,
        isReference: false,
        start: "2026-06-15T00:00:00.000Z",
        end: "2026-06-20T00:00:00.000Z",
        duration: 5,
        granularity: "days",
      },
    },
  },
  planNames: { a: "Customer", r: "Customer" },
};

const describeEntry = (fields: Partial<AuditLogEntry>) =>
  describeAuditEntry(entry(fields), history, "days");

describe("audit log text", () => {
  it("lists a task's changed values", () => {
    const { title, detail } = describeEntry({
      details: { name: "New", duration: 3, granularity: "weeks", notes: "x" },
    });
    expect(title).toBe("Updated");
    expect(detail).toBe("Name: New · Duration: 3 weeks · Notes changed");
  });

  it("says when a change came from an approved request", () => {
    expect(describeEntry({ details: { changeRequestId: "cr" } }).title).toBe(
      "Approved change applied",
    );
  });

  it("shows a request's plan, proposed values and reason when it is raised", () => {
    const text = describeEntry({ entityType: "changeRequest", entityId: "cr", action: "create" });
    expect(text.title).toBe("Requested: Change: Delivery");
    expect(text.detail).toContain("From Supplier");
    expect(text.detail).toContain("5 days");
    expect(text.comment).toBe("Supplier delay");
  });

  it("shows how a request ended, without repeating its reason", () => {
    const text = describeEntry({
      entityType: "changeRequest",
      entityId: "cr",
      action: "supersede",
    });
    expect(text.title).toBe("Replaced by a newer change: Change: Delivery");
    expect(text.comment).toBe("");
  });

  it("shows who decided an approval and their comment", () => {
    expect(
      describeEntry({
        entityType: "approval",
        entityId: "a",
        action: "reject",
        details: { comment: "Too late" },
      }),
    ).toEqual({ title: "Rejected for Customer", detail: "", comment: "Too late" });
  });

  it("describes uses of the task and their link type", () => {
    expect(
      describeEntry({
        entityType: "planItemReference",
        entityId: "r",
        action: "create",
        details: { linkType: "AGREEMENT" },
      }).title,
    ).toBe("Used in Customer (AGREEMENT)");
    expect(describeEntry({ entityType: "planLink", action: "upgrade" }).title).toBe(
      "Link upgraded to AGREEMENT",
    );
  });

  it("falls back to the raw names for anything else", () => {
    expect(describeEntry({ entityType: "widget", action: "spin" }).title).toBe("Widget: spin");
  });
});
