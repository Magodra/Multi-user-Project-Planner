/**
 * MCP server (CLAUDE.md §2 "MCP interface"): a thin layer over /services.
 * Every call runs as the authenticated user with origin "MCP".
 * There are deliberately no tools for approving, rejecting or accepting
 * ChangeRequests — approvals are UI only (also enforced in the service).
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  compareBaselinesInput,
  createBaselineInput,
  createChangeRequestInput,
  createTaskInput,
  moveTaskInput,
  proposeTaskChangeInput,
  reorderTaskInput,
  changeTaskLevelInput,
  runReportInput,
  setPredecessorsInput,
  updateTaskInput,
} from "@planning/shared";
import { AppError } from "../domain/errors.js";
import type { Services } from "../services/Services.js";
import type { ServiceContext } from "../services/support.js";

export const MCP_TOOL_NAMES = [
  "list_projects",
  "list_plans",
  "get_plan_items",
  "create_task",
  "update_task",
  "move_task",
  "reorder_task",
  "change_task_level",
  "set_predecessors",
  "propose_task_change",
  "create_baseline",
  "compare_baselines",
  "create_change_request",
  "list_pending_approvals",
  "run_report",
] as const;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message =
    err instanceof AppError
      ? `${err.code}: ${err.message}`
      : err instanceof z.ZodError
        ? `VALIDATION: ${z.prettifyError(err)}`
        : `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

function json(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) },
    ],
  };
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function createMcpServer(services: Services, ctx: ServiceContext): McpServer {
  const server = new McpServer({ name: "multi-user-project-planner", version: "0.1.0" });
  const id = z.string().min(1);

  server.registerTool(
    "list_projects",
    { title: "List projects", description: "Projects the current user can access." },
    () => run(() => services.projects.list(ctx)),
  );

  server.registerTool(
    "list_plans",
    { title: "List plans", description: "Plans in a project.", inputSchema: { projectId: id } },
    ({ projectId }) => run(() => services.plans.list(ctx, projectId)),
  );

  server.registerTool(
    "get_plan_items",
    {
      title: "Get plan tasks",
      description:
        "Tasks of a plan (Estimated track = live values) with derived kinds, external references, dependencies and links.",
      inputSchema: { planId: id },
    },
    ({ planId }) => run(() => services.plans.getView(ctx, planId)),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task. Duration 0 makes a milestone; adding subtasks makes the parent an activity.",
      inputSchema: createTaskInput.shape,
    },
    (args) => run(() => services.items.create(ctx, createTaskInput.parse(args))),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update a task's name, notes, schedule or ownership. Requires the current version (optimistic locking).",
      inputSchema: { itemId: id, ...updateTaskInput.shape },
    },
    ({ itemId, ...rest }) =>
      run(() => services.items.update(ctx, itemId, updateTaskInput.parse(rest))),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description: "Move a task in time (keeping its duration) and/or in the hierarchy.",
      inputSchema: { itemId: id, ...moveTaskInput.shape },
    },
    ({ itemId, ...rest }) => run(() => services.items.move(ctx, itemId, moveTaskInput.parse(rest))),
  );

  server.registerTool(
    "reorder_task",
    {
      title: "Reorder task",
      description: "Move a task one place up or down among its siblings in the plan.",
      inputSchema: { itemId: id, ...reorderTaskInput.shape },
    },
    ({ itemId, ...rest }) =>
      run(() => services.items.reorder(ctx, itemId, reorderTaskInput.parse(rest))),
  );

  server.registerTool(
    "change_task_level",
    {
      title: "Indent or outdent task",
      description:
        "Indent a task (make it a subtask of the task above it) or outdent it (move it up one level, right after its parent).",
      inputSchema: { itemId: id, ...changeTaskLevelInput.shape },
    },
    ({ itemId, ...rest }) =>
      run(() => services.items.changeLevel(ctx, itemId, changeTaskLevelInput.parse(rest))),
  );

  server.registerTool(
    "set_predecessors",
    {
      title: "Set predecessors",
      description:
        "Replace a task's predecessors in a plan using that plan's local task IDs (own tasks and external tasks used in it), e.g. '4FS+3d; 2SS-1d; 7'. Pass planId to set predecessors of an external task in the plan using it. Types FS, SS, FF, SF (default FS); lag units h, d, w (working time on the project calendar), mo, y (default: the task's granularity); a negative lag is a lead. An empty string removes them.",
      inputSchema: { itemId: id, ...setPredecessorsInput.shape },
    },
    ({ itemId, ...rest }) =>
      run(() => services.items.setPredecessors(ctx, itemId, setPredecessorsInput.parse(rest))),
  );

  server.registerTool(
    "propose_task_change",
    {
      title: "Propose task change",
      description:
        "Propose new values (name, start, end, duration, granularity) for an external task used in this plan through an AGREEMENT reference. The task's owner plan must approve in the UI; monitored (MONITOR) references cannot be changed.",
      inputSchema: { referenceId: id, ...proposeTaskChangeInput.shape },
    },
    ({ referenceId, ...rest }) =>
      run(() =>
        services.changeRequests.proposeTaskChange(
          ctx,
          referenceId,
          proposeTaskChangeInput.parse(rest),
        ),
      ),
  );

  server.registerTool(
    "create_baseline",
    {
      title: "Create baseline",
      description: "Create a snapshot (locked by default) or a what-if branch of a plan.",
      inputSchema: createBaselineInput.shape,
    },
    (args) => run(() => services.baselines.create(ctx, createBaselineInput.parse(args))),
  );

  server.registerTool(
    "compare_baselines",
    {
      title: "Compare baselines",
      description:
        "Compare the live plan with tracks (CURRENT, AGREED) or baseline ids; returns end-date variance.",
      inputSchema: compareBaselinesInput.shape,
    },
    (args) => run(() => services.baselines.compare(ctx, compareBaselinesInput.parse(args))),
  );

  server.registerTool(
    "create_change_request",
    {
      title: "Create change request",
      description:
        "Propose accepting tasks into the Current or Agreed track (or promoting a branch). Approval must be given by people in the UI.",
      inputSchema: createChangeRequestInput.shape,
    },
    (args) => run(() => services.changeRequests.create(ctx, createChangeRequestInput.parse(args))),
  );

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description:
        "Approvals waiting for the current user. Read-only: decisions are made in the UI.",
      inputSchema: { projectId: id.optional() },
    },
    ({ projectId }) => run(() => services.changeRequests.listPending(ctx, projectId)),
  );

  server.registerTool(
    "run_report",
    {
      title: "Run report",
      description:
        "Run a saved ReportDefinition against live data or a baseline. PDF output is base64.",
      inputSchema: { reportId: id, ...runReportInput.shape },
    },
    ({ reportId, ...rest }) =>
      run(() => services.reports.run(ctx, reportId, runReportInput.parse(rest))),
  );

  // --- resources -------------------------------------------------------------

  server.registerResource(
    "projects",
    "planning://projects",
    { title: "Projects", mimeType: "application/json" },
    async (uri) => json(uri, await services.projects.list(ctx)),
  );

  server.registerResource(
    "project",
    new ResourceTemplate("planning://project/{projectId}", { list: undefined }),
    { title: "Project", mimeType: "application/json" },
    async (uri, vars) => {
      const projectId = param(vars.projectId);
      return json(uri, {
        project: await services.projects.get(ctx, projectId),
        plans: await services.plans.list(ctx, projectId),
        reports: await services.reports.list(ctx, projectId),
      });
    },
  );

  server.registerResource(
    "plan",
    new ResourceTemplate("planning://project/{projectId}/plan/{planId}", { list: undefined }),
    { title: "Plan", mimeType: "application/json" },
    async (uri, vars) => {
      const view = await services.plans.getView(ctx, param(vars.planId));
      return json(uri, { ...view, baselines: await services.baselines.tree(ctx, view.plan.id) });
    },
  );

  server.registerResource(
    "baseline",
    new ResourceTemplate("planning://project/{projectId}/plan/{planId}/baseline/{baselineId}", {
      list: undefined,
    }),
    { title: "Baseline", mimeType: "application/json" },
    async (uri, vars) => json(uri, await services.baselines.get(ctx, param(vars.baselineId))),
  );

  server.registerResource(
    "report",
    new ResourceTemplate("planning://project/{projectId}/report/{reportId}", { list: undefined }),
    { title: "Report definition", mimeType: "application/json" },
    async (uri, vars) => json(uri, await services.reports.get(ctx, param(vars.reportId))),
  );

  return server;
}
