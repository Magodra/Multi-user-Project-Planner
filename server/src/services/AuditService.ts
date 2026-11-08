import type { AuditLogEntry, TaskHistory, TaskHistoryRequest } from "@planning/shared";
import { ForbiddenError } from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import { type ServiceContext, mustGet, newMeta, timeOrderedId } from "./support.js";

export interface AuditRecord {
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  details?: Record<string, unknown>;
}

/** Writes the immutable AuditLog. Always called inside the transaction of the change. */
export class AuditService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
  ) {}

  async record(tx: StorageAdapter, ctx: ServiceContext, record: AuditRecord): Promise<void> {
    const entry: AuditLogEntry = {
      ...newMeta(ctx),
      // Time-ordered: entries written in the same millisecond keep their order.
      id: timeOrderedId(),
      projectId: record.projectId,
      entityType: record.entityType,
      entityId: record.entityId,
      action: record.action,
      origin: ctx.origin,
      details: record.details ?? {},
    };
    await tx.save("auditLog", entry);
  }

  async list(ctx: ServiceContext, projectId: string, entityId?: string): Promise<AuditLogEntry[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    const entries = await this.storage.query(
      "auditLog",
      entityId ? { projectId, entityId } : { projectId },
    );
    return entries.sort(byTime);
  }

  /**
   * One task's history: its own changes, the requests covering it with their
   * approvals and comments, and its uses, link types and dependencies. A task
   * spans the projects of the plans using it; only projects the user can read
   * are included.
   */
  async taskHistory(ctx: ServiceContext, itemId: string): Promise<TaskHistory> {
    const task = await mustGet(this.storage, "task", itemId);
    const references = await this.storage.query("planItemReference", { itemId });
    const projectIds: string[] = [];
    for (const id of new Set([task.projectId, ...references.map((r) => r.projectId)])) {
      if (await this.access.canDo(ctx, id, null, "project.read")) projectIds.push(id);
    }
    if (projectIds.length === 0) throw new ForbiddenError("No access to this task");

    const planName = async (planId: string) => (await this.storage.get("plan", planId))?.name ?? "";
    const requests: Record<string, TaskHistoryRequest> = {};
    const planNames: Record<string, string> = {};
    const ids = new Set<string>([itemId]);
    for (const ref of references) {
      ids.add(ref.id);
      planNames[ref.id] = await planName(ref.planId);
    }
    let entries: AuditLogEntry[] = [];
    for (const projectId of projectIds) {
      for (const cr of await this.storage.query("changeRequest", { projectId })) {
        if (!cr.itemIds.includes(itemId)) continue;
        ids.add(cr.id);
        requests[cr.id] = {
          title: cr.title,
          kind: cr.kind,
          description: cr.description,
          planName: await planName(cr.planId),
          proposed: cr.proposed.find((p) => p.itemId === itemId) ?? null,
        };
        for (const approval of await this.storage.query("approval", { changeRequestId: cr.id })) {
          ids.add(approval.id);
          planNames[approval.id] = await planName(approval.planId);
        }
      }
      for (const d of await this.storage.query("dependency", { projectId })) {
        if (d.fromItemId === itemId || d.toItemId === itemId) ids.add(d.id);
      }
      entries.push(...(await this.storage.query("auditLog", { projectId })));
    }
    // Removed references and dependencies are found through their "create" entry.
    for (const e of entries) {
      const { itemId: item, fromItemId, toItemId, referenceId, planId } = e.details;
      if (item === itemId || fromItemId === itemId || toItemId === itemId) {
        ids.add(e.entityId);
        if (e.entityType === "planItemReference" && typeof planId === "string")
          planNames[e.entityId] ??= await planName(planId);
      }
      if (typeof referenceId === "string" && ids.has(referenceId)) ids.add(e.entityId);
    }
    entries = entries.filter((e) => ids.has(e.entityId));
    return { entries: entries.sort(byTime), requests, planNames };
  }
}

const timeKey = (e: AuditLogEntry) => `${e.createdAt}|${e.id}`;
const byTime = (a: AuditLogEntry, b: AuditLogEntry) =>
  timeKey(a) < timeKey(b) ? -1 : timeKey(a) > timeKey(b) ? 1 : 0;
