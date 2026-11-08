/**
 * Approval rules for ChangeRequests (CLAUDE.md §6 "Acceptance workflow").
 * Pure logic, no I/O.
 */
import type {
  AcceptanceGranularity,
  Approval,
  ApprovalStatus,
  BaselineDefinition,
  ChangeRequestStatus,
  Plan,
  PlanItemReference,
  PlanLink,
  RequestOrigin,
  Role,
  User,
} from "@planning/shared";
import { ForbiddenError, RuleViolationError } from "./errors.js";
import { effectiveLinkType, governingLink } from "./links.js";

/** One item covered by a ChangeRequest, with what is needed to find its approvers. */
export interface CoveredItem {
  itemId: string;
  /** The plan that owns the item. */
  ownerPlanId: string;
  ownership: "INTERNAL" | "EXTERNAL";
  /** The owner plan's project. */
  projectId: string;
}

export interface RequiredApproval {
  planId: string;
  partyId: string | null;
  roles: Role[];
  reason: string;
}

export interface ApprovalContext {
  /** Plan in which the ChangeRequest is raised. */
  planId: string;
  definition: BaselineDefinition;
  items: CoveredItem[];
  /** All references in the project (to find recipients of external items). */
  references: PlanItemReference[];
  links: PlanLink[];
  plans: Map<string, Plan>;
}

/**
 * Who must approve a ChangeRequest:
 * - the requesting plan's approvers (per the definition);
 * - for external items with rule OWNER_AND_RECIPIENTS: the owner plan and
 *   every recipient plan;
 * - for references on AGREEMENT links (when accepting to Agreed): every
 *   party to the link.
 * Returns an empty list when the definition requires no approval.
 */
export function requiredApprovals(ctx: ApprovalContext): RequiredApproval[] {
  const { definition } = ctx;
  if (!definition.requiresApproval) return [];
  const roles = definition.approvers.length > 0 ? definition.approvers : (["PLAN_OWNER"] as Role[]);
  const result = new Map<string, RequiredApproval>();
  const add = (
    planId: string,
    reason: string,
    partyId: string | null = ctx.plans.get(planId)?.ownerPartyId ?? null,
  ) => {
    const key = `${planId}|${partyId ?? ""}`;
    if (!result.has(key)) result.set(key, { planId, partyId, roles: [...roles], reason });
  };

  add(ctx.planId, "Plan approval");

  for (const item of ctx.items) {
    if (item.ownership !== "EXTERNAL") continue;
    const refs = ctx.references.filter((r) => r.itemId === item.itemId);
    if (definition.externalItemRule === "OWNER_AND_RECIPIENTS") {
      add(item.ownerPlanId, "Owner of external task");
      for (const r of refs) add(r.planId, "Recipient of external task");
    }
    if (definition.track === "AGREED") {
      for (const r of refs) {
        if (effectiveLinkType(r, ctx.links) !== "AGREEMENT") continue;
        const link = governingLink(r, ctx.links)!;
        add(link.fromPlanId, "Party to AGREEMENT link");
        add(link.toPlanId, "Party to AGREEMENT link");
        for (const partyId of link.partyIds) add(link.toPlanId, "Party to AGREEMENT link", partyId);
      }
    }
  }
  return [...result.values()].sort((a, b) =>
    `${a.planId}|${a.partyId ?? ""}` < `${b.planId}|${b.partyId ?? ""}` ? -1 : 1,
  );
}

/** A plan using a task under AGREEMENT, with the extra parties of its link. */
export interface AgreementUse {
  plan: Plan;
  definition: BaselineDefinition;
  partyIds: string[];
}

/**
 * A schedule change to a task in its owner plan, when other plans use the task
 * under AGREEMENT: each of those plans, and the extra parties on its link,
 * must approve it, with the approvers of their Estimated definition.
 */
export function usingPlanApprovals(uses: AgreementUse[]): RequiredApproval[] {
  return uses.flatMap(({ plan, definition, partyIds }) =>
    [plan.ownerPartyId ?? null, ...partyIds].map((partyId) => ({
      planId: plan.id,
      partyId,
      roles:
        definition.approvers.length > 0 ? [...definition.approvers] : (["PLAN_OWNER"] as Role[]),
      reason: "Uses the task under AGREEMENT",
    })),
  );
}

/** Check the number of covered items against the definition's acceptance granularity. */
export function assertAcceptanceGranularity(
  granularity: AcceptanceGranularity,
  requested: number,
  totalInPlan: number,
): void {
  if (requested === 0)
    throw new RuleViolationError("A change request must cover at least one task");
  if (granularity === "ITEM" && requested !== 1) {
    throw new RuleViolationError("This baseline accepts one task per change request");
  }
  if (granularity === "WHOLE_PLAN" && requested !== totalInPlan) {
    throw new RuleViolationError("This baseline only accepts the whole plan at once");
  }
}

/** CR status after an approval decision: any rejection rejects, all approvals approve. */
export function resolveStatus(approvals: Pick<Approval, "status">[]): ChangeRequestStatus {
  if (approvals.some((a) => a.status === "REJECTED")) return "REJECTED";
  if (approvals.every((a) => a.status === "APPROVED")) return "APPROVED";
  return "PENDING";
}

export function assertPending(status: ChangeRequestStatus): void {
  if (status !== "PENDING") throw new RuleViolationError(`Change request is ${status}`);
}

/** Approvals are UI only — MCP (and any non-UI origin) may never decide them. */
export function assertApprovalOrigin(origin: RequestOrigin): void {
  if (origin !== "UI")
    throw new ForbiddenError("Approvals can only be given in the user interface");
}

/** Whether a user may decide an approval: a listed role on its plan, or representing its party. */
export function canDecide(
  approval: Pick<Approval, "roles" | "partyId" | "status">,
  user: Pick<User, "partyIds">,
  rolesOnPlan: Role[],
): boolean {
  if (approval.status !== "PENDING") return false;
  if (approval.partyId !== null && user.partyIds.includes(approval.partyId)) return true;
  return approval.roles.some((r) => rolesOnPlan.includes(r));
}

export function decisionStatus(decision: "APPROVE" | "REJECT"): ApprovalStatus {
  return decision === "APPROVE" ? "APPROVED" : "REJECTED";
}

/**
 * A change proposed from a recipient plan (on an AGREEMENT reference) is
 * decided by the task's owner plan, with the approvers of the Estimated
 * definition, which governs changes to the live plan.
 */
export function taskChangeApproval(
  ownerPlan: Plan,
  definition: BaselineDefinition,
): RequiredApproval {
  return {
    planId: ownerPlan.id,
    partyId: ownerPlan.ownerPartyId ?? null,
    roles: definition.approvers.length > 0 ? [...definition.approvers] : ["PLAN_OWNER"],
    reason: "Owner of the task",
  };
}
