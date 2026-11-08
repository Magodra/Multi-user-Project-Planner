/**
 * Entity types shared by client and server.
 *
 * All timestamps are ISO-8601 strings in UTC. Item kinds (task, milestone,
 * activity) are never stored — see `getItemKind` in ./domain/itemKind.ts.
 */

export type UUID = string;
/** ISO-8601 timestamp in UTC, e.g. "2026-01-05T00:00:00.000Z". */
export type IsoDateTime = string;

export interface Versioned {
  id: UUID;
  version: number;
  createdAt: IsoDateTime;
  createdBy: UUID;
  updatedAt: IsoDateTime;
  updatedBy: UUID;
}

export const GRANULARITIES = ["hours", "days", "weeks", "months", "years"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const ROLES = ["ADMIN", "PLAN_OWNER", "EDITOR", "APPROVER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const TRACKS = ["ESTIMATED", "CURRENT", "AGREED"] as const;
export type Track = (typeof TRACKS)[number];

export type Ownership = "INTERNAL" | "EXTERNAL";
export type LinkType = "MONITOR" | "AGREEMENT";
export type DependencyType = "FS" | "SS" | "FF" | "SF";

/** Agreement state of an item (owner side) or a reference (recipient side). */
export type AgreementState = "NONE" | "PROPOSED" | "AGREED" | "REJECTED";

export interface WorkingCalendar {
  /** Working weekdays, 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  /** Start of the working day in hours (UTC), e.g. 8. */
  workdayStartHour: number;
  /** End of the working day in hours (UTC), e.g. 16. */
  workdayEndHour: number;
  /** Non-working dates, "YYYY-MM-DD". */
  holidays: string[];
}

export interface Project extends Versioned {
  name: string;
  /** Free-text classification, e.g. "Contract" or "R&D". */
  projectType: string;
  description: string;
  /** Parent in the project hierarchy; null for a top-level project. */
  parentProjectId: UUID | null;
  /** Inactive projects are kept but hidden from the projects page by default. */
  active: boolean;
  calendar: WorkingCalendar;
}

export interface Plan extends Versioned {
  projectId: UUID;
  name: string;
  /** User-defined plan type, e.g. "contract", "internal", "reporting". */
  planType: string;
  description: string;
  ownerPartyId: UUID | null;
}

/** Scheduling values of an item; used by live items and baseline snapshots. */
export interface Schedule {
  start: IsoDateTime;
  end: IsoDateTime;
  /** Duration in units of `granularity`. Zero means milestone. */
  duration: number;
  granularity: Granularity;
}

/** The single item entity in a plan. Live values are the Estimated track. */
export interface Task extends Versioned, Schedule {
  projectId: UUID;
  planId: UUID;
  parentId: UUID | null;
  /** Per-plan task ID shown to users and used in predecessor notation; never reused or renumbered. */
  taskNumber: number;
  name: string;
  notes: string;
  /** Position among siblings (same parent). */
  sortOrder: number;
  ownership: Ownership;
  agreementState: AgreementState;
}

/** Use of an external item in a recipient plan. Holds no copy of the dates. */
export interface PlanItemReference extends Versioned {
  projectId: UUID;
  planId: UUID;
  itemId: UUID;
  ownerPlanId: UUID;
  /** Local task ID in this (recipient) plan, from the same sequence as the plan's own tasks. */
  taskNumber: number;
  /** Local parent task in this (recipient) plan; null at the top level. */
  parentId: UUID | null;
  /** Position among its siblings; tasks and references share one order. */
  sortOrder: number;
  agreementState: AgreementState;
}

/**
 * The link type of one reference (an external task used in another plan).
 * Without a link a reference is MONITOR. Stored with the reference, in the
 * recipient plan's project.
 */
export interface PlanLink extends Versioned {
  projectId: UUID;
  type: LinkType;
  /** Owner plan of the task. */
  fromPlanId: UUID;
  /** Recipient plan (where the task is used). */
  toPlanId: UUID;
  /** The reference this link applies to. */
  referenceId: UUID;
  /** Additional parties that must approve on AGREEMENT links. */
  partyIds: UUID[];
}

export interface Dependency extends Versioned {
  /** Project of `planId`, where the dependency is stored. */
  projectId: UUID;
  /**
   * The plan the dependency belongs to: both tasks are visible there (own
   * tasks or external tasks used in it). Its editors manage the dependency.
   */
  planId: UUID;
  fromItemId: UUID;
  toItemId: UUID;
  type: DependencyType;
  /** Lag in `lagUnit`; negative is a lead. */
  lag: number;
  lagUnit: Granularity;
}

export interface BaselineItem extends Schedule {
  itemId: UUID;
  name: string;
  parentId: UUID | null;
  /** True when the snapshot entry is for a reference to an external item. */
  isReference: boolean;
}

export type BaselineKind = "TRACK" | "SNAPSHOT" | "BRANCH";

export interface Baseline extends Versioned {
  projectId: UUID;
  planId: UUID;
  name: string;
  kind: BaselineKind;
  /** Set for TRACK baselines (CURRENT or AGREED; ESTIMATED is the live plan). */
  track: Track | null;
  definitionId: UUID | null;
  parentBaselineId: UUID | null;
  locked: boolean;
  lockedAt: IsoDateTime | null;
  items: BaselineItem[];
}

export type ExternalItemRule = "OWNER_ONLY" | "OWNER_AND_RECIPIENTS";
export type AcceptanceGranularity = "ITEM" | "BATCH" | "WHOLE_PLAN";

export interface BaselineDefinition extends Versioned {
  projectId: UUID;
  name: string;
  /** The track this definition governs. */
  track: Track;
  acceptFrom: Track;
  requiresApproval: boolean;
  approvers: Role[];
  externalItemRule: ExternalItemRule;
  granularityOfAcceptance: AcceptanceGranularity;
  lockOnAccept: boolean;
  allowBranching: boolean;
}

export type ChangeRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";

/**
 * PROPOSE_TASK_CHANGE: a recipient plan proposes new values (name, schedule)
 * for an external task on an AGREEMENT reference; the owner plan decides and,
 * when approved, the values are applied to the task. `planId` is the
 * recipient plan and `proposed` holds the requested values.
 */
export type ChangeRequestKind = "ACCEPT_TO_TRACK" | "PROMOTE_BRANCH" | "PROPOSE_TASK_CHANGE";

export interface ChangeRequest extends Versioned {
  projectId: UUID;
  planId: UUID;
  kind: ChangeRequestKind;
  title: string;
  description: string;
  targetTrack: Track;
  /** Items (or referenced items) covered by the request. */
  itemIds: UUID[];
  /** For PROMOTE_BRANCH: the branch baseline whose values are promoted. */
  sourceBaselineId: UUID | null;
  /** Proposed schedules, captured when the request was created. */
  proposed: BaselineItem[];
  status: ChangeRequestStatus;
  requestedBy: UUID;
  origin: RequestOrigin;
  resolvedAt: IsoDateTime | null;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

/** One party's (or plan's) approval of a ChangeRequest. */
export interface Approval extends Versioned {
  projectId: UUID;
  changeRequestId: UUID;
  /** The plan on whose behalf the approval is given. */
  planId: UUID;
  partyId: UUID | null;
  /** Roles (on `planId`) that may decide this approval. */
  roles: Role[];
  reason: string;
  status: ApprovalStatus;
  decidedBy: UUID | null;
  decidedAt: IsoDateTime | null;
  comment: string;
}

export interface TimelineRow {
  id: string;
  name: string;
}

/** Where an entry sits in its row: a callout above the timeline, a bar on it, or a callout below. */
export type TimelinePlacement = "above" | "on" | "below";

export interface TimelineEntry {
  id: string;
  rowId: string;
  /** References the plan item — the timeline never copies dates. */
  itemId: UUID;
  planId: UUID;
  placement: TimelinePlacement;
  /** Bar line, from 0 at the top. Callouts use `calloutX` and `calloutY` instead. */
  line: number;
  /**
   * A callout's free position, in px: from its attachment point on the bar's
   * edge (the middle of a task, or a milestone's date) to the label's left
   * edge and to its edge nearest the bar. `calloutY` is at most 0 above the
   * bar and greater than 0 below it. Bars have neither.
   */
  calloutX?: number;
  calloutY?: number;
}

export interface Timeline extends Versioned {
  projectId: UUID;
  name: string;
  start: IsoDateTime;
  end: IsoDateTime;
  scale: Granularity;
  rows: TimelineRow[];
  entries: TimelineEntry[];
}

/** UI state of a workspace that lives outside the panel layout. */
export interface WorkspaceViewState {
  /** Projects expanded in the Project panel's structure tree. */
  expandedProjectIds: UUID[];
}

export interface Workspace extends Versioned {
  projectId: UUID;
  userId: UUID;
  name: string;
  /** Serialised Dockview layout (opaque to the server). */
  layout: unknown;
  /** Null until first saved; the client then uses its defaults. */
  viewState: WorkspaceViewState | null;
}

export type ReportFormat = "html" | "pdf" | "csv";

export interface ReportDefinition extends Versioned {
  projectId: UUID;
  name: string;
  planIds: UUID[];
  timelineIds: UUID[];
  /** Baselines to compare against (overlay columns). */
  baselineIds: UUID[];
  rangeStart: IsoDateTime | null;
  rangeEnd: IsoDateTime | null;
  granularity: Granularity;
  filter: { nameContains?: string; kinds?: ItemKind[] };
}

export interface User extends Versioned {
  username: string;
  displayName: string;
  email: string;
  authSource: "local" | "sso" | "ldap";
  /** scrypt hash; only for local users. Never sent to clients. */
  passwordHash: string | null;
  isSystemAdmin: boolean;
  /** Roles granted in every project, e.g. through `auth.roleMapping`. */
  globalRoles: Role[];
  partyIds: UUID[];
  externalGroups: string[];
  /** The user's own UI settings, kept across sign-ins. Missing on users stored before it existed. */
  preferences?: UserPreferences;
}

/** UI settings a user keeps across sign-ins. */
export interface UserPreferences {
  /** Projects expanded in the projects page's tree (default: none). */
  expandedProjectIds: UUID[];
}

export type PublicUser = Omit<User, "passwordHash">;

export interface Party extends Versioned {
  name: string;
  description: string;
}

/**
 * A client registered for MCP OAuth (dynamic client registration, RFC 7591),
 * e.g. ChatGPT. `id` is the client_id. Kept across restarts so a connected
 * client only has to sign in again, not register again.
 */
export interface OAuthClient extends Versioned {
  /** The registration as returned to the client (RFC 7591 client information). */
  registration: Record<string, unknown>;
}

export interface RoleAssignment extends Versioned {
  projectId: UUID;
  userId: UUID;
  /** Null means project-wide. */
  planId: UUID | null;
  role: Role;
}

export type RequestOrigin = "UI" | "MCP" | "SYSTEM";

export interface AuditLogEntry extends Versioned {
  projectId: UUID | null;
  entityType: string;
  entityId: UUID;
  action: string;
  origin: RequestOrigin;
  details: Record<string, unknown>;
}

export type ItemKind = "task" | "milestone" | "activity";
