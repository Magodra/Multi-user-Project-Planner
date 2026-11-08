/**
 * Mapping between entity types and SQL tables.
 *
 * Each table has `id`, `version`, `created_at`, `updated_at`, a `data` column
 * holding the entity as JSON, and real columns for every queryable field.
 * Baseline items and timeline entries are stored as rows in child tables.
 * Must match the migrations in ./migrations.
 */
import type { EntityType } from "../StorageAdapter.js";

export type ColumnKind = "string" | "number" | "boolean";

export interface ColumnSpec {
  field: string;
  column: string;
  kind: ColumnKind;
}

export interface ChildSpec {
  /** Array field on the parent entity. */
  field: string;
  table: string;
  parentColumn: string;
  /** Unique key of a child within its parent. */
  keyField: string;
  columns: ColumnSpec[];
}

export interface TableSpec {
  table: string;
  columns: ColumnSpec[];
  child?: ChildSpec;
}

const s = (field: string, column: string): ColumnSpec => ({ field, column, kind: "string" });
const projectId = s("projectId", "project_id");
const planId = s("planId", "plan_id");

export const TABLES: Record<EntityType, TableSpec> = {
  project: { table: "project", columns: [] },
  plan: { table: "plan", columns: [projectId] },
  task: { table: "plan_item", columns: [projectId, planId, s("parentId", "parent_id")] },
  planItemReference: {
    table: "plan_item_reference",
    columns: [projectId, planId, s("itemId", "item_id")],
  },
  planLink: {
    table: "plan_link",
    columns: [
      projectId,
      s("fromPlanId", "from_plan_id"),
      s("toPlanId", "to_plan_id"),
      s("referenceId", "reference_id"),
    ],
  },
  dependency: {
    table: "dependency",
    columns: [projectId, s("fromItemId", "from_item_id"), s("toItemId", "to_item_id")],
  },
  baseline: {
    table: "baseline",
    columns: [projectId, planId, s("kind", "kind"), s("track", "track")],
    child: {
      field: "items",
      table: "baseline_item",
      parentColumn: "baseline_id",
      keyField: "itemId",
      columns: [
        s("itemId", "item_id"),
        s("name", "name"),
        s("parentId", "parent_id"),
        s("start", "start_at"),
        s("end", "end_at"),
        { field: "duration", column: "duration", kind: "number" },
        s("granularity", "granularity"),
        { field: "isReference", column: "is_reference", kind: "boolean" },
      ],
    },
  },
  baselineDefinition: { table: "baseline_definition", columns: [projectId, s("track", "track")] },
  changeRequest: { table: "change_request", columns: [projectId, planId, s("status", "status")] },
  approval: {
    table: "approval",
    columns: [projectId, s("changeRequestId", "change_request_id"), planId, s("status", "status")],
  },
  timeline: {
    table: "timeline",
    columns: [projectId],
    child: {
      field: "entries",
      table: "timeline_entry",
      parentColumn: "timeline_id",
      keyField: "id",
      columns: [
        s("id", "entry_id"),
        s("rowId", "row_id"),
        s("itemId", "item_id"),
        s("planId", "plan_id"),
        s("placement", "placement"),
        { field: "line", column: "line", kind: "number" },
        { field: "calloutX", column: "callout_x", kind: "number" },
        { field: "calloutY", column: "callout_y", kind: "number" },
      ],
    },
  },
  workspace: { table: "workspace", columns: [projectId, s("userId", "user_id")] },
  reportDefinition: { table: "report_definition", columns: [projectId] },
  user: { table: "app_user", columns: [s("username", "username")] },
  party: { table: "party", columns: [] },
  oauthClient: { table: "oauth_client", columns: [] },
  roleAssignment: {
    table: "role_assignment",
    columns: [projectId, s("userId", "user_id"), planId],
  },
  auditLog: { table: "audit_log", columns: [projectId, s("entityId", "entity_id")] },
};
