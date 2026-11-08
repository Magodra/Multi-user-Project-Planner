/**
 * Workflow steps shared by ItemService and ChangeRequestService:
 * saving task changes, agreement states, superseding open ChangeRequests and
 * roll-up of activities (including referenced tasks placed under them).
 */
import {
  type AgreementState,
  type Approval,
  type ChangeRequest,
  type ChangeRequestWithApprovals,
  type LinkType,
  type PlanItemReference,
  type PlanLink,
  type Schedule,
  type Task,
  type WorkingCalendar,
  nowIso,
} from "@planning/shared";
import { mergeBaselineItems } from "../domain/baselines.js";
import { type PlacedSchedule, rollUpActivities } from "../domain/items.js";
import { type AgreementUse, usingPlanApprovals } from "../domain/approvals.js";
import {
  carryOverAgreedValues,
  effectiveLinkType,
  governingLink,
  referencesUnderLink,
} from "../domain/links.js";
import { normalizeReference } from "../domain/references.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AuditService } from "./AuditService.js";
import { findTrackBaseline, getDefinition } from "./lookups.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";

/** The state an item falls back to when nothing is proposed or rejected. */
export async function restingState(
  tx: StorageAdapter,
  planId: string,
  itemId: string,
): Promise<AgreementState> {
  const agreed = await findTrackBaseline(tx, planId, "AGREED");
  return agreed?.items.some((i) => i.itemId === itemId) ? "AGREED" : "NONE";
}

/**
 * Set the agreement state of an item (owner side) and its references
 * (recipient side). `decide` returns the state per plan, or null to keep it.
 */
export async function updateAgreementStates(
  tx: StorageAdapter,
  ctx: ServiceContext,
  itemId: string,
  decide: (
    planId: string,
    current: AgreementState,
    isOwner: boolean,
  ) => Promise<AgreementState | null>,
): Promise<void> {
  const item = await tx.get("task", itemId);
  if (!item) return;
  const ownerState = await decide(item.planId, item.agreementState, true);
  if (ownerState !== null && ownerState !== item.agreementState) {
    await tx.save("task", touch(item, ctx, { agreementState: ownerState }));
  }
  for (const ref of await tx.query("planItemReference", { itemId })) {
    const state = await decide(ref.planId, ref.agreementState, false);
    if (state !== null && state !== ref.agreementState) {
      await tx.save("planItemReference", touch(ref, ctx, { agreementState: state }));
    }
  }
}

/** Revert PROPOSED states of a request that will not be accepted. */
export async function revertProposed(
  tx: StorageAdapter,
  ctx: ServiceContext,
  cr: ChangeRequest,
): Promise<void> {
  if (cr.targetTrack !== "AGREED") return;
  for (const itemId of cr.itemIds) {
    await updateAgreementStates(tx, ctx, itemId, async (planId, current) =>
      current === "PROPOSED" ? restingState(tx, planId, itemId) : null,
    );
  }
}

/**
 * A new change to an item with an open ChangeRequest supersedes that request
 * (CLAUDE.md §6.5). Returns the superseded requests.
 */
export async function supersedeOpenRequests(
  tx: StorageAdapter,
  ctx: ServiceContext,
  audit: AuditService,
  projectId: string,
  itemIds: string[],
  filter: (cr: ChangeRequest) => boolean = () => true,
): Promise<ChangeRequest[]> {
  const open = await tx.query("changeRequest", { projectId, status: "PENDING" });
  const affected = open.filter((cr) => cr.itemIds.some((id) => itemIds.includes(id)) && filter(cr));
  const result: ChangeRequest[] = [];
  for (const cr of affected) {
    const saved = await tx.save(
      "changeRequest",
      touch(cr, ctx, { status: "SUPERSEDED", resolvedAt: nowIso() }),
    );
    await revertProposed(tx, ctx, saved);
    await audit.record(tx, ctx, {
      projectId,
      entityType: "changeRequest",
      entityId: cr.id,
      action: "supersede",
      details: { itemIds },
    });
    result.push(saved);
  }
  return result;
}

/**
 * Recompute rolled-up activity schedules of a plan and save the changed ones.
 * Referenced tasks placed under local tasks count as subtasks. Plans (also in
 * other projects) that placed this plan's tasks under their own activities
 * are rolled up too, with their own project's calendar.
 */
export async function rollUpPlan(
  tx: StorageAdapter,
  projectId: string,
  planId: string,
  calendar: WorkingCalendar,
  visited: Set<string> = new Set(),
): Promise<void> {
  visited.add(planId);
  const tasks = await tx.query("task", { projectId, planId });
  const placed: PlacedSchedule[] = [];
  for (const r of (await tx.query("planItemReference", { planId })).map(normalizeReference)) {
    if (r.parentId === null) continue;
    const item = await tx.get("task", r.itemId);
    if (item) {
      const { start, end, duration, granularity } = item;
      placed.push({ parentId: r.parentId, start, end, duration, granularity });
    }
  }
  for (const changed of rollUpActivities(tasks, calendar, placed)) await tx.save("task", changed);
  for (const task of tasks.filter((t) => t.ownership === "EXTERNAL")) {
    for (const r of (await referencesOf(tx, task.id)).filter((x) => x.parentId !== null)) {
      if (visited.has(r.planId)) continue;
      const project = await tx.get("project", r.projectId);
      await rollUpPlan(tx, r.projectId, r.planId, project?.calendar ?? calendar, visited);
    }
  }
}

/** Every reference to a task, in any project. */
export async function referencesOf(
  tx: StorageAdapter,
  itemId: string,
): Promise<PlanItemReference[]> {
  return (await tx.query("planItemReference", { itemId })).map(normalizeReference);
}

/** The plans using a task under AGREEMENT: its owner's schedule changes need their approval. */
export async function agreementUses(tx: StorageAdapter, task: Task): Promise<AgreementUse[]> {
  const uses: AgreementUse[] = [];
  for (const ref of await referencesOf(tx, task.id)) {
    const links = await tx.query("planLink", { projectId: ref.projectId });
    if (effectiveLinkType(ref, links) !== "AGREEMENT") continue;
    uses.push({
      plan: await mustGet(tx, "plan", ref.planId),
      definition: await getDefinition(tx, ref.projectId, "ESTIMATED"),
      partyIds: governingLink(ref, links)?.partyIds ?? [],
    });
  }
  return uses;
}

/**
 * Propose a schedule change to a task from its owner plan, instead of applying
 * it: the plans in `uses` decide, and the change is applied once they all
 * approve. A newer proposal from the owner replaces the older one.
 */
export async function proposeOwnerScheduleChange(
  tx: StorageAdapter,
  ctx: ServiceContext,
  audit: AuditService,
  task: Task,
  schedule: Schedule,
  uses: AgreementUse[],
  description: string,
): Promise<ChangeRequestWithApprovals> {
  await supersedeOwnerProposals(tx, ctx, audit, task);
  const changeRequest: ChangeRequest = {
    ...newMeta(ctx),
    projectId: task.projectId,
    planId: task.planId,
    kind: "PROPOSE_TASK_CHANGE",
    title: `Change: ${task.name}`,
    description,
    targetTrack: "ESTIMATED",
    itemIds: [task.id],
    sourceBaselineId: null,
    proposed: [
      {
        itemId: task.id,
        name: task.name,
        parentId: task.parentId,
        isReference: false,
        ...schedule,
      },
    ],
    status: "PENDING",
    requestedBy: ctx.user.id,
    origin: ctx.origin,
    resolvedAt: null,
  };
  const saved = await tx.save("changeRequest", changeRequest);
  const projectOf = new Map(uses.map((u) => [u.plan.id, u.plan.projectId]));
  const approvals: Approval[] = [];
  for (const required of usingPlanApprovals(uses)) {
    approvals.push(
      await tx.save("approval", {
        ...newMeta(ctx),
        // Stored with the deciding plan's project: its members see and decide it.
        projectId: projectOf.get(required.planId) ?? task.projectId,
        changeRequestId: changeRequest.id,
        planId: required.planId,
        partyId: required.partyId,
        roles: required.roles,
        reason: required.reason,
        status: "PENDING",
        decidedBy: null,
        decidedAt: null,
        comment: "",
      }),
    );
  }
  await audit.record(tx, ctx, {
    projectId: task.projectId,
    entityType: "changeRequest",
    entityId: changeRequest.id,
    action: "create",
    details: {
      kind: changeRequest.kind,
      itemIds: changeRequest.itemIds,
      approvals: approvals.length,
    },
  });
  return { changeRequest: saved, approvals };
}

/**
 * Supersede the owner's own open proposals on a task, also when a plan stops
 * using it under AGREEMENT: its approval could then never be decided.
 */
export async function supersedeOwnerProposals(
  tx: StorageAdapter,
  ctx: ServiceContext,
  audit: AuditService,
  task: Task,
): Promise<ChangeRequest[]> {
  return supersedeOpenRequests(
    tx,
    ctx,
    audit,
    task.projectId,
    [task.id],
    (cr) => cr.kind === "PROPOSE_TASK_CHANGE" && cr.planId === task.planId,
  );
}

/** Copy the owner's agreed values into the recipient's Agreed track where missing (CLAUDE.md §4). */
export async function carryOverAgreed(tx: StorageAdapter, link: PlanLink): Promise<number> {
  const refs = referencesUnderLink(
    link,
    await tx.query("planItemReference", { planId: link.toPlanId }),
  );
  const ownerAgreed = await findTrackBaseline(tx, link.fromPlanId, "AGREED");
  const recipientAgreed = await findTrackBaseline(tx, link.toPlanId, "AGREED");
  if (!ownerAgreed || !recipientAgreed) return 0;
  const additions = carryOverAgreedValues(refs, ownerAgreed.items, recipientAgreed.items);
  if (additions.length > 0) {
    await tx.save("baseline", {
      ...recipientAgreed,
      items: mergeBaselineItems(recipientAgreed.items, additions),
    });
    for (const ref of refs.filter((r) => additions.some((a) => a.itemId === r.itemId))) {
      if (ref.agreementState === "NONE")
        await tx.save("planItemReference", { ...ref, agreementState: "AGREED" });
    }
  }
  return additions.length;
}

/**
 * Set the link type of one reference (stored with the reference, in the
 * recipient's project). An upgrade to AGREEMENT carries over agreed values and
 * needs no approval round.
 */
export async function setReferenceLinkType(
  tx: StorageAdapter,
  ctx: ServiceContext,
  audit: AuditService,
  ref: PlanItemReference,
  type: LinkType,
  partyIds?: string[],
): Promise<PlanLink> {
  const [existing] = await tx.query("planLink", { projectId: ref.projectId, referenceId: ref.id });
  const parties = partyIds ?? existing?.partyIds ?? [];
  if (existing?.type === type && existing.partyIds.join() === parties.join()) return existing;
  if (existing?.type === "AGREEMENT" && type === "MONITOR")
    await supersedeOwnerProposals(tx, ctx, audit, await mustGet(tx, "task", ref.itemId));
  const link: PlanLink = existing
    ? await tx.save("planLink", touch(existing, ctx, { type, partyIds: parties }))
    : await tx.save("planLink", {
        ...newMeta(ctx),
        projectId: ref.projectId,
        type,
        fromPlanId: ref.ownerPlanId,
        toPlanId: ref.planId,
        referenceId: ref.id,
        partyIds: parties,
      });
  const carried =
    type === "AGREEMENT" && existing?.type !== "AGREEMENT" ? await carryOverAgreed(tx, link) : 0;
  await audit.record(tx, ctx, {
    projectId: ref.projectId,
    entityType: "planLink",
    entityId: link.id,
    action: existing ? (type === "AGREEMENT" ? "upgrade" : "downgrade") : "create",
    details: { referenceId: ref.id, type, carriedOverItems: carried },
  });
  return link;
}

/** Direct children of a task: its subtasks and references placed under it. */
export async function childCount(tx: StorageAdapter, task: Task): Promise<number> {
  const [subtasks, refs] = await Promise.all([
    tx.query("task", { projectId: task.projectId, parentId: task.id }),
    tx.query("planItemReference", { planId: task.planId }),
  ]);
  return subtasks.length + refs.filter((r) => normalizeReference(r).parentId === task.id).length;
}

/**
 * Save a changed task, supersede open requests on it (except `keepRequestId`,
 * the request being accepted), reset a REJECTED state and roll up.
 */
export async function saveTaskChange(
  tx: StorageAdapter,
  ctx: ServiceContext,
  audit: AuditService,
  before: Task,
  after: Task,
  calendar: WorkingCalendar,
  action: string,
  details: object,
  keepRequestId?: string,
): Promise<void> {
  await tx.save("task", after);
  await supersedeOpenRequests(
    tx,
    ctx,
    audit,
    before.projectId,
    [before.id],
    (cr) => cr.id !== keepRequestId,
  );
  // A rejected state is kept only until the item changes (CLAUDE.md §6.6).
  await updateAgreementStates(tx, ctx, before.id, async (_planId, current) =>
    current === "REJECTED" ? "NONE" : null,
  );
  await rollUpPlan(tx, before.projectId, before.planId, calendar);
  await audit.record(tx, ctx, {
    projectId: before.projectId,
    entityType: "task",
    entityId: before.id,
    action,
    details: { ...details },
  });
}

/**
 * Plans (and their projects) whose views show a change to these tasks: the
 * tasks' own plans and every plan using one of them or one of their
 * activities, whose dates roll up from them.
 */
export async function taskChangeAudience(
  storage: StorageAdapter,
  tasks: Task[],
): Promise<{ projectIds: string[]; planIds: string[] }> {
  const projectIds = new Set<string>();
  const planIds = new Set<string>();
  const seen = new Set<string>();
  for (const start of tasks) {
    let task: Task | null = start;
    while (task && !seen.has(task.id)) {
      seen.add(task.id);
      projectIds.add(task.projectId);
      planIds.add(task.planId);
      for (const r of await storage.query("planItemReference", { itemId: task.id })) {
        projectIds.add(r.projectId);
        planIds.add(r.planId);
      }
      task = task.parentId ? await storage.get("task", task.parentId) : null;
    }
  }
  return { projectIds: [...projectIds], planIds: [...planIds] };
}
