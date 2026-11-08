/** StorageAdapter contract, run against every backend (CLAUDE.md §12). */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AuditLogEntry, Baseline, OAuthClient, Party, Task, Timeline } from "@planning/shared";
import { ConflictError, ValidationError } from "../domain/errors.js";
import type { StorageAdapter } from "./StorageAdapter.js";
import { allBackends } from "../testing/backends.js";

const NOW = "2026-01-05T00:00:00.000Z";
const meta = () => ({
  id: randomUUID(),
  version: 0,
  createdAt: NOW,
  createdBy: "u",
  updatedAt: NOW,
  updatedBy: "u",
});

function task(projectId: string, planId: string, extra: Partial<Task> = {}): Task {
  return {
    ...meta(),
    projectId,
    planId,
    parentId: null,
    taskNumber: 1,
    name: "Task",
    notes: "",
    sortOrder: 0,
    ownership: "INTERNAL",
    agreementState: "NONE",
    start: NOW,
    end: "2026-01-06T00:00:00.000Z",
    duration: 1,
    granularity: "days",
    ...extra,
  };
}

describe.each(allBackends)("StorageAdapter contract: $name", (backend) => {
  let storage: StorageAdapter;
  let cleanup: () => Promise<void>;
  let projectId: string;

  beforeEach(async () => {
    ({ storage, cleanup } = await backend.create());
    projectId = randomUUID();
  });
  afterEach(async () => cleanup());
  afterAll(async () => backend.teardown());

  it("creates with version 1 and reads back", async () => {
    const t = task(projectId, "p1");
    const saved = await storage.save("task", t);
    expect(saved.version).toBe(1);
    expect(await storage.get("task", t.id)).toEqual(saved);
  });

  it("returns null for unknown ids", async () => {
    expect(await storage.get("task", randomUUID())).toBeNull();
  });

  it("increments version on update and rejects stale versions", async () => {
    const saved = await storage.save("task", task(projectId, "p1"));
    const updated = await storage.save("task", { ...saved, name: "Renamed" });
    expect(updated.version).toBe(2);
    await expect(storage.save("task", { ...saved, name: "Stale" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await storage.get("task", saved.id))?.name).toBe("Renamed");
  });

  it("rejects creating an entity twice", async () => {
    const t = task(projectId, "p1");
    await storage.save("task", t);
    await expect(storage.save("task", t)).rejects.toBeInstanceOf(ConflictError);
  });

  it("queries by equality, including null, in id order", async () => {
    const parent = await storage.save("task", task(projectId, "p1"));
    await storage.save("task", task(projectId, "p1", { parentId: parent.id }));
    await storage.save("task", task(projectId, "p2"));
    expect(await storage.query("task", { projectId, planId: "p1" })).toHaveLength(2);
    const roots = await storage.query("task", { projectId, parentId: null });
    expect(roots).toHaveLength(2);
    const ids = roots.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("rejects filters on non-queryable fields", async () => {
    await expect(storage.query("task", { name: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("deletes with optimistic locking", async () => {
    const saved = await storage.save("task", task(projectId, "p1"));
    await expect(storage.delete("task", saved.id, 99)).rejects.toBeInstanceOf(ConflictError);
    await storage.delete("task", saved.id, saved.version);
    expect(await storage.get("task", saved.id)).toBeNull();
  });

  it("stores child collections (baseline items, timeline entries) in order", async () => {
    const baseline: Baseline = {
      ...meta(),
      projectId,
      planId: "p1",
      name: "B1",
      kind: "SNAPSHOT",
      track: null,
      definitionId: null,
      parentBaselineId: null,
      locked: true,
      lockedAt: NOW,
      items: [
        {
          itemId: "b",
          name: "B",
          parentId: null,
          start: NOW,
          end: NOW,
          duration: 0,
          granularity: "days",
          isReference: false,
        },
        {
          itemId: "a",
          name: "A",
          parentId: "b",
          start: NOW,
          end: "2026-01-07T00:00:00.000Z",
          duration: 2.5,
          granularity: "hours",
          isReference: true,
        },
      ],
    };
    const saved = await storage.save("baseline", baseline);
    expect(await storage.get("baseline", baseline.id)).toEqual(saved);
    const timeline: Timeline = {
      ...meta(),
      projectId,
      name: "T",
      start: NOW,
      end: NOW,
      scale: "weeks",
      rows: [{ id: "r1", name: "Row" }],
      entries: [{ id: "e1", rowId: "r1", itemId: "i1", planId: "p1", placement: "on", line: 0 }],
    };
    await storage.save("timeline", timeline);
    const callout = {
      id: "e2",
      rowId: "r1",
      itemId: "i2",
      planId: "p1",
      placement: "below" as const,
      line: 0,
      calloutX: -30,
      calloutY: 42,
    };
    const withCallout = await storage.save("timeline", {
      ...timeline,
      version: 1,
      entries: [callout],
    });
    expect((await storage.get("timeline", timeline.id))?.entries).toEqual([callout]);
    const updated = await storage.save("timeline", { ...withCallout, entries: [] });
    expect((await storage.get("timeline", timeline.id))?.entries).toEqual([]);
    expect(updated.version).toBe(3);
  });

  it("handles global entities", async () => {
    const party: Party = { ...meta(), name: `Party ${randomUUID()}`, description: "" };
    await storage.save("party", party);
    expect((await storage.query("party")).some((p) => p.id === party.id)).toBe(true);
    const client: OAuthClient = {
      ...meta(),
      registration: { client_name: "ChatGPT", redirect_uris: ["https://example.com/cb"] },
    };
    await storage.save("oauthClient", client);
    expect((await storage.get("oauthClient", client.id))?.registration).toEqual(
      client.registration,
    );
  });

  it("keeps the audit log append-only", async () => {
    const entry: AuditLogEntry = {
      ...meta(),
      projectId,
      entityType: "task",
      entityId: "t1",
      action: "create",
      origin: "UI",
      details: { a: 1 },
    };
    const saved = await storage.save("auditLog", entry);
    expect(await storage.query("auditLog", { projectId })).toEqual([saved]);
    await expect(storage.save("auditLog", saved)).rejects.toBeInstanceOf(ConflictError);
    await expect(storage.delete("auditLog", saved.id, saved.version)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("commits transactions atomically", async () => {
    const a = task(projectId, "p1");
    const b = task(projectId, "p1");
    await storage.transaction(async (tx) => {
      await tx.save("task", a);
      expect(await tx.get("task", a.id)).not.toBeNull();
      await tx.save("task", b);
    });
    expect(await storage.query("task", { projectId })).toHaveLength(2);
  });

  it("rolls back transactions on error", async () => {
    const existing = await storage.save("task", task(projectId, "p1"));
    const fresh = task(projectId, "p1");
    await expect(
      storage.transaction(async (tx) => {
        await tx.save("task", fresh);
        await tx.save("task", { ...existing, name: "changed" });
        await tx.save("task", { ...existing, name: "conflict" }); // stale version
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await storage.get("task", fresh.id)).toBeNull();
    expect((await storage.get("task", existing.id))?.name).toBe("Task");
  });

  it("serialises concurrent writers with optimistic locking", async () => {
    const saved = await storage.save("task", task(projectId, "p1"));
    const results = await Promise.allSettled([
      storage.save("task", { ...saved, name: "one" }),
      storage.save("task", { ...saved, name: "two" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
