/** Response shapes of the REST API and MCP tools, plus realtime messages. */
import type {
  Granularity,
  DependencyType,
  AgreementState,
  Approval,
  AuditLogEntry,
  Baseline,
  BaselineItem,
  ChangeRequest,
  Dependency,
  ItemKind,
  LinkType,
  Plan,
  PlanItemReference,
  PlanLink,
  Project,
  PublicUser,
  Role,
  Task,
} from "./types.js";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export interface AuthInfo {
  mode: "local" | "sso" | "ldap";
  /** True in local mode when no users exist yet and the first admin can be created. */
  setupRequired: boolean;
}

/** A plan that uses an external task, with the reference's effective link type. */
export interface RecipientInfo {
  referenceId: string;
  planId: string;
  planName: string;
  projectId: string;
  projectName: string;
  linkType: LinkType;
}

/** A plan an external task can be added to (same project tree, edit rights). */
export interface ReferenceTarget {
  planId: string;
  planName: string;
  projectId: string;
  projectName: string;
}

/** A dependency whose successor starts (FS, SS) or finishes (FF, SF) too early. Slack is fine. */
export interface DependencyIssue {
  dependencyId: string;
  /** Earliest allowed start or finish of the successor. */
  required: string;
  /** Its actual start or finish. */
  actual: string;
}

/** A dependency problem with names, for summaries outside the plan's Gantt. */
export interface DependencyIssueSummary extends DependencyIssue {
  type: DependencyType;
  lag: number;
  lagUnit: Granularity;
  /** Predecessor and successor names (external tasks with their owner plan). */
  fromName: string;
  toName: string;
}

/** Dependency problems of one plan (only plans the user can read). */
export interface PlanDependencyIssues {
  planId: string;
  issues: DependencyIssueSummary[];
}

/** Values proposed for an external task, waiting for its owner's approval. */
export interface ProposedChange {
  changeRequestId: string;
  /** The plan that proposed the change. */
  planId: string;
  proposed: BaselineItem;
  description: string;
}

/** A project in the projects list, with whether the current user may edit it. */
export interface ProjectSummary extends Project {
  canEdit: boolean;
}

/** A reference resolved with the owner's live values. */
export interface ResolvedReference extends PlanItemReference {
  item: Task;
  linkType: LinkType;
  /** Name of the plan that owns the task (it may belong to another project of the tree). */
  ownerPlanName: string;
  /** The task's kind in its owner plan: an activity's dates follow its subtasks there. */
  itemKind: ItemKind;
}

export interface PlanView {
  plan: Plan;
  items: Task[];
  kinds: Record<string, ItemKind>;
  references: ResolvedReference[];
  dependencies: Dependency[];
  links: PlanLink[];
  /** Roles the current user has on this plan. */
  myRoles: Role[];
  /** Items (or referenced items) with a pending ChangeRequest. */
  pendingItemIds: string[];
  /** Pending changes proposed from recipient plans (PROPOSE_TASK_CHANGE) for tasks shown here. */
  proposedChanges: ProposedChange[];
  /** Dependencies the successor does not respect (starts or finishes too early). */
  dependencyIssues: DependencyIssue[];
  /** Plans (possibly in other projects of the tree) using each external task owned by this plan. */
  recipients: Record<string, RecipientInfo[]>;
  /** Ids of this plan's Current and Agreed track baselines. */
  trackBaselineIds: { CURRENT: string | null; AGREED: string | null };
}

export interface VarianceRow {
  itemId: string;
  name: string;
  live: BaselineItem | null;
  /** Keyed by the compared baseline id or track name. */
  against: Record<string, BaselineItem | null>;
  /** End variance in calendar days per compared baseline (positive = later). */
  endVarianceDays: Record<string, number | null>;
  agreementState: AgreementState;
}

export interface BaselineComparison {
  planId: string;
  columns: { key: string; name: string }[];
  rows: VarianceRow[];
}

export interface ChangeRequestWithApprovals {
  changeRequest: ChangeRequest;
  approvals: Approval[];
}

export interface PendingApproval {
  approval: Approval;
  changeRequest: ChangeRequest;
  planName: string;
}

/** An open ChangeRequest covering a task, with the approvals the current user can decide. */
/** A change request as shown in a task's audit log. */
export interface TaskHistoryRequest {
  title: string;
  kind: ChangeRequest["kind"];
  description: string;
  /** Plan that raised the request. */
  planName: string;
  /** The values proposed for this task. */
  proposed: BaselineItem | null;
}

/** Everything the audit log holds about one task, oldest first. */
export interface TaskHistory {
  entries: AuditLogEntry[];
  /** Change requests covering the task, by id. */
  requests: Record<string, TaskHistoryRequest>;
  /** Plan name of each approval and reference, by their id. */
  planNames: Record<string, string>;
}

export interface TaskApprovalRequest {
  changeRequest: ChangeRequest;
  approvals: Approval[];
  /** Pending approvals of this request that the current user may decide. */
  decidableApprovalIds: string[];
  /** Plan that raised the request. */
  planName: string;
  /** Plan names for the approvals (they can be in other projects of the tree). */
  planNames: Record<string, string>;
}

export interface BaselineTreeNode {
  baseline: Omit<Baseline, "items">;
  children: BaselineTreeNode[];
}

export interface ReportResult {
  contentType: string;
  fileName: string;
  /** Text for html/csv, base64 for pdf. */
  body: string;
  encoding: "utf8" | "base64";
}

/** Server → client WebSocket message. */
export type RealtimeMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | {
      type: "changed";
      projectId: string;
      entityType: string;
      entityId: string;
      action: string;
      /** Plans whose views are affected, so clients can refresh selectively. */
      planIds: string[];
    };

/** Client → server WebSocket message. */
export type RealtimeClientMessage =
  { type: "auth"; token: string } | { type: "subscribe"; projectId: string };
