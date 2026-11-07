/**
 * Zod schemas for inputs to the REST API and MCP tools. Both layers validate
 * with these, so the contract is defined once.
 */
import { z } from "zod";
import { GRANULARITIES, ROLES } from "./types.js";

const id = z.string().min(1);
const isoDateTime = z.iso.datetime({ offset: true });

export const granularitySchema = z.enum(GRANULARITIES);
export const roleSchema = z.enum(ROLES);
export const trackSchema = z.enum(["ESTIMATED", "CURRENT", "AGREED"]);
export const linkTypeSchema = z.enum(["MONITOR", "AGREEMENT"]);
export const dependencyTypeSchema = z.enum(["FS", "SS", "FF", "SF"]);

export const workingCalendarSchema = z.object({
  workingDays: z.array(z.number().int().min(0).max(6)),
  workdayStartHour: z.number().min(0).max(24),
  workdayEndHour: z.number().min(0).max(24),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});

export const loginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const setupInput = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string(),
  password: z.string().min(1),
});

export const createUserInput = setupInput.extend({
  isSystemAdmin: z.boolean().default(false),
  partyIds: z.array(id).default([]),
});

export const createPartyInput = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
});

export const createProjectInput = z.object({
  name: z.string().min(1),
  projectType: z.string().default(""),
  description: z.string().default(""),
  parentProjectId: id.nullable().default(null),
  calendar: workingCalendarSchema.optional(),
});

export const updateProjectInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).optional(),
  projectType: z.string().optional(),
  description: z.string().optional(),
  parentProjectId: id.nullable().optional(),
  active: z.boolean().optional(),
  calendar: workingCalendarSchema.optional(),
});

export const assignRoleInput = z.object({
  userId: id,
  planId: id.nullable().default(null),
  role: roleSchema,
});

export const createPlanInput = z.object({
  name: z.string().min(1),
  planType: z.string().min(1),
  description: z.string().default(""),
  ownerPartyId: id.nullable().default(null),
});

export const createTaskInput = z.object({
  planId: id,
  parentId: id.nullable().default(null),
  name: z.string().min(1),
  start: isoDateTime,
  duration: z.number().min(0),
  granularity: granularitySchema,
  notes: z.string().default(""),
  ownership: z.enum(["INTERNAL", "EXTERNAL"]).default("INTERNAL"),
});

export const updateTaskInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  start: isoDateTime.optional(),
  /** When given without `duration`, the duration is recomputed from start/end. */
  end: isoDateTime.optional(),
  duration: z.number().min(0).optional(),
  granularity: granularitySchema.optional(),
  ownership: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
});

export const moveTaskInput = z.object({
  version: z.number().int(),
  start: isoDateTime.optional(),
  parentId: id.nullable().optional(),
  sortOrder: z.number().optional(),
});

export const addReferenceInput = z.object({
  itemId: id,
  planId: id,
  /** Link type for this reference; omitted: MONITOR. */
  linkType: linkTypeSchema.optional(),
});

/** Set the link type (MONITOR or AGREEMENT) of one reference. */
export const setReferenceTypeInput = z.object({
  type: linkTypeSchema,
  /** Additional parties that must approve on an AGREEMENT link; omitted: unchanged. */
  partyIds: z.array(id).optional(),
});

export const createDependencyInput = z.object({
  fromItemId: id,
  toItemId: id,
  /** Plan in which both tasks are shown; defaults to the successor's plan. */
  planId: id.optional(),
  type: dependencyTypeSchema.default("FS"),
  lag: z.number().default(0),
  /** Defaults to the successor's granularity. */
  lagUnit: granularitySchema.optional(),
});

/** Replace a task's predecessors within its plan, e.g. "4FS+3d; 2SS". Empty clears them. */
export const setPredecessorsInput = z.object({
  predecessors: z.string(),
  /** Plan whose task IDs the notation uses; defaults to the task's own plan (needed for external tasks). */
  planId: id.optional(),
});

/** Place a reference in the recipient plan's hierarchy. */
export const moveReferenceInput = z.object({
  version: z.number().int(),
  parentId: id.nullable(),
});

/** A local change to an AGREEMENT reference: proposed to the task's owner for approval. */
export const proposeTaskChangeInput = z.object({
  name: z.string().min(1).optional(),
  start: isoDateTime.optional(),
  /** When given without `duration`, the duration is recomputed from start/end. */
  end: isoDateTime.optional(),
  duration: z.number().min(0).optional(),
  granularity: granularitySchema.optional(),
  description: z.string().default(""),
});

export const reorderTaskInput = z.object({
  version: z.number().int(),
  direction: z.enum(["up", "down"]),
});

/**
 * Indent: make a task (or reference) a subtask of the task above it.
 * Outdent: move it up one level, right after its current parent.
 */
export const changeTaskLevelInput = z.object({
  version: z.number().int(),
  direction: z.enum(["indent", "outdent"]),
});

export const createBaselineInput = z.object({
  planId: id,
  name: z.string().min(1),
  kind: z.enum(["SNAPSHOT", "BRANCH"]),
  /** Baseline to copy from; null copies the live (Estimated) plan. */
  fromBaselineId: id.nullable().default(null),
  lock: z.boolean().default(true),
});

export const updateBaselineItemInput = z.object({
  version: z.number().int(),
  start: isoDateTime,
  duration: z.number().min(0),
  granularity: granularitySchema,
});

export const compareBaselinesInput = z.object({
  planId: id,
  /** Baselines to compare; "ESTIMATED" | "CURRENT" | "AGREED" or baseline ids. */
  against: z.array(z.string().min(1)).min(1),
});

export const createChangeRequestInput = z
  .object({
    planId: id,
    /** ESTIMATED is only valid when promoting a branch. */
    targetTrack: trackSchema,
    /** Items to accept. Empty means the whole plan. */
    itemIds: z.array(id).default([]),
    /** For promoting a what-if branch. */
    sourceBaselineId: id.nullable().default(null),
    title: z.string().min(1),
    description: z.string().default(""),
  })
  .refine((v) => v.targetTrack !== "ESTIMATED" || v.sourceBaselineId !== null, {
    message: "Only a branch can be promoted to Estimated",
    path: ["targetTrack"],
  });

export const decideApprovalInput = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().default(""),
});

const timelineRowSchema = z.object({ id: z.string().min(1), name: z.string() });
const timelineEntrySchema = z.object({
  id: z.string().min(1),
  rowId: z.string().min(1),
  itemId: id,
  planId: id,
  placement: z.enum(["above", "on", "below"]).default("on"),
  line: z.number().int().min(0).default(0),
});

export const createTimelineInput = z.object({
  name: z.string().min(1),
  start: isoDateTime,
  end: isoDateTime,
  scale: granularitySchema,
  rows: z.array(timelineRowSchema).default([{ id: "row-1", name: "Row 1" }]),
});

export const updateTimelineInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).optional(),
  start: isoDateTime.optional(),
  end: isoDateTime.optional(),
  scale: granularitySchema.optional(),
  rows: z.array(timelineRowSchema).optional(),
  entries: z.array(timelineEntrySchema).optional(),
});

export const workspaceViewStateSchema = z.object({
  expandedProjectIds: z.array(id),
});

export const userPreferencesSchema = z.object({
  expandedProjectIds: z.array(id),
});

export const saveWorkspaceInput = z.object({
  version: z.number().int().optional(),
  name: z.string().min(1),
  layout: z.unknown(),
  /** Omitted on update: keep the stored view state. */
  viewState: workspaceViewStateSchema.nullable().optional(),
});

export const reportDefinitionInput = z.object({
  name: z.string().min(1),
  planIds: z.array(id).min(1),
  timelineIds: z.array(id).default([]),
  baselineIds: z.array(id).default([]),
  rangeStart: isoDateTime.nullable().default(null),
  rangeEnd: isoDateTime.nullable().default(null),
  granularity: granularitySchema.default("days"),
  filter: z
    .object({
      nameContains: z.string().optional(),
      kinds: z.array(z.enum(["task", "milestone", "activity"])).optional(),
    })
    .default({}),
});

export const runReportInput = z.object({
  format: z.enum(["html", "pdf", "csv"]).default("html"),
  /** Run against a specific baseline instead of live data. */
  asOfBaselineId: id.nullable().default(null),
});

export type LoginInput = z.infer<typeof loginInput>;
export type SetupInput = z.infer<typeof setupInput>;
export type CreateUserInput = z.infer<typeof createUserInput>;
export type CreatePartyInput = z.infer<typeof createPartyInput>;
export type CreateProjectInput = z.infer<typeof createProjectInput>;
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
export type AssignRoleInput = z.infer<typeof assignRoleInput>;
export type CreatePlanInput = z.infer<typeof createPlanInput>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type MoveTaskInput = z.infer<typeof moveTaskInput>;
export type AddReferenceInput = z.infer<typeof addReferenceInput>;
export type SetReferenceTypeInput = z.infer<typeof setReferenceTypeInput>;
export type CreateDependencyInput = z.infer<typeof createDependencyInput>;
export type SetPredecessorsInput = z.infer<typeof setPredecessorsInput>;
export type ReorderTaskInput = z.infer<typeof reorderTaskInput>;
export type ChangeTaskLevelInput = z.infer<typeof changeTaskLevelInput>;
export type MoveReferenceInput = z.infer<typeof moveReferenceInput>;
export type ProposeTaskChangeInput = z.infer<typeof proposeTaskChangeInput>;
export type CreateBaselineInput = z.infer<typeof createBaselineInput>;
export type UpdateBaselineItemInput = z.infer<typeof updateBaselineItemInput>;
export type CompareBaselinesInput = z.infer<typeof compareBaselinesInput>;
export type CreateChangeRequestInput = z.infer<typeof createChangeRequestInput>;
export type DecideApprovalInput = z.infer<typeof decideApprovalInput>;
export type CreateTimelineInput = z.infer<typeof createTimelineInput>;
export type UpdateTimelineInput = z.infer<typeof updateTimelineInput>;
export type SaveWorkspaceInput = z.infer<typeof saveWorkspaceInput>;
export type ReportDefinitionInput = z.infer<typeof reportDefinitionInput>;
export type RunReportInput = z.infer<typeof runReportInput>;
