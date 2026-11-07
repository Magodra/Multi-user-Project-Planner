/**
 * Typed REST client. The bearer token lives only in memory (never in
 * localStorage, which is shared by all files on file://). The client never
 * knows which storage backend the server uses.
 */
import type {
  AddReferenceInput,
  ApiErrorBody,
  AssignRoleInput,
  AuthInfo,
  Baseline,
  BaselineComparison,
  BaselineDefinition,
  BaselineTreeNode,
  ChangeRequest,
  ChangeRequestWithApprovals,
  CompareBaselinesInput,
  CreateBaselineInput,
  CreateChangeRequestInput,
  CreateDependencyInput,
  CreatePlanInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTimelineInput,
  DecideApprovalInput,
  Dependency,
  LoginResult,
  MoveReferenceInput,
  MoveTaskInput,
  PendingApproval,
  Plan,
  PlanDependencyIssues,
  PlanItemReference,
  PlanLink,
  PlanView,
  Project,
  ProjectSummary,
  ProposeTaskChangeInput,
  ReferenceTarget,
  PublicUser,
  ReorderTaskInput,
  ChangeTaskLevelInput,
  ReportDefinition,
  ReportDefinitionInput,
  RoleAssignment,
  RunReportInput,
  SaveWorkspaceInput,
  SetPredecessorsInput,
  SetReferenceTypeInput,
  SetupInput,
  TaskApprovalRequest,
  Task,
  Timeline,
  UpdateBaselineItemInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateTimelineInput,
  UserPreferences,
  Workspace,
} from "@planning/shared";
import { apiUrl } from "../config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function getToken(): string | null {
  return token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

type Input = Partial<CreateTaskInput> | object;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the planning server");
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, err?.error.code ?? "HTTP", err?.error.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: Input = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: Input) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: Input) => request<T>("PUT", path, body);
const del = (path: string) => request<void>("DELETE", path);
const enc = encodeURIComponent;

export const api = {
  auth: {
    info: () => get<AuthInfo>("/api/auth/info"),
    setup: (input: SetupInput) => post<LoginResult>("/api/auth/setup", input),
    login: (username: string, password: string) =>
      post<LoginResult>("/api/auth/login", { username, password }),
    exchange: (code: string) => post<LoginResult>("/api/auth/sso/exchange", { code }),
    logout: () => post<void>("/api/auth/logout"),
    me: () => get<PublicUser>("/api/auth/me"),
    ssoStartUrl: () => `${apiUrl}/api/auth/sso/start`,
  },
  users: {
    list: () => get<PublicUser[]>("/api/users"),
    /** The signed-in user's own UI settings. */
    setPreferences: (preferences: UserPreferences) =>
      put<PublicUser>("/api/users/me/preferences", preferences),
  },
  projects: {
    list: () => get<ProjectSummary[]>("/api/projects"),
    create: (input: Partial<CreateProjectInput> & { name: string }) =>
      post<Project>("/api/projects", input),
    get: (id: string) => get<Project>(`/api/projects/${enc(id)}`),
    update: (id: string, input: UpdateProjectInput) =>
      patch<Project>(`/api/projects/${enc(id)}`, input),
    members: (id: string) => get<RoleAssignment[]>(`/api/projects/${enc(id)}/members`),
    assignRole: (id: string, input: AssignRoleInput) =>
      post<RoleAssignment>(`/api/projects/${enc(id)}/members`, input),
    removeRole: (id: string, assignmentId: string) =>
      del(`/api/projects/${enc(id)}/members/${enc(assignmentId)}`),
    definitions: (id: string) => get<BaselineDefinition[]>(`/api/projects/${enc(id)}/definitions`),
  },
  plans: {
    list: (projectId: string) => get<Plan[]>(`/api/projects/${enc(projectId)}/plans`),
    dependencyIssues: (projectId: string) =>
      get<PlanDependencyIssues[]>(`/api/projects/${enc(projectId)}/dependency-issues`),
    create: (projectId: string, input: CreatePlanInput) =>
      post<Plan>(`/api/projects/${enc(projectId)}/plans`, input),
    view: (planId: string) => get<PlanView>(`/api/plans/${enc(planId)}/view`),
    update: (
      planId: string,
      input: { version: number; name?: string; planType?: string; description?: string },
    ) => patch<Plan>(`/api/plans/${enc(planId)}`, input),
    delete: (planId: string, version: number) =>
      del(`/api/plans/${enc(planId)}?version=${version}`),
  },
  items: {
    get: (id: string) => get<Task>(`/api/items/${enc(id)}`),
    create: (input: CreateTaskInput) => post<Task>("/api/items", input),
    update: (id: string, input: UpdateTaskInput) => patch<Task>(`/api/items/${enc(id)}`, input),
    move: (id: string, input: MoveTaskInput) => post<Task>(`/api/items/${enc(id)}/move`, input),
    reorder: (id: string, input: ReorderTaskInput) =>
      post<Task>(`/api/items/${enc(id)}/reorder`, input),
    changeLevel: (id: string, input: ChangeTaskLevelInput) =>
      post<Task>(`/api/items/${enc(id)}/level`, input),
    setPredecessors: (id: string, input: SetPredecessorsInput) =>
      put<Dependency[]>(`/api/items/${enc(id)}/predecessors`, input),
    delete: (id: string, version: number) => del(`/api/items/${enc(id)}?version=${version}`),
    addReference: (input: Partial<AddReferenceInput> & { itemId: string; planId: string }) =>
      post<PlanItemReference>("/api/references", input),
    referenceTargets: (itemId: string) =>
      get<ReferenceTarget[]>(`/api/items/${enc(itemId)}/reference-targets`),
    setReferenceType: (id: string, input: SetReferenceTypeInput) =>
      post<PlanLink>(`/api/references/${enc(id)}/type`, input),
    removeReference: (id: string) => del(`/api/references/${enc(id)}`),
    moveReference: (id: string, input: MoveReferenceInput) =>
      post<PlanItemReference>(`/api/references/${enc(id)}/move`, input),
    reorderReference: (id: string, input: ReorderTaskInput) =>
      post<PlanItemReference>(`/api/references/${enc(id)}/reorder`, input),
    changeReferenceLevel: (id: string, input: ChangeTaskLevelInput) =>
      post<PlanItemReference>(`/api/references/${enc(id)}/level`, input),
    proposeTaskChange: (id: string, input: Partial<ProposeTaskChangeInput>) =>
      post<ChangeRequestWithApprovals>(`/api/references/${enc(id)}/propose`, input),
    createDependency: (input: CreateDependencyInput) =>
      post<Dependency>("/api/dependencies", input),
    deleteDependency: (id: string) => del(`/api/dependencies/${enc(id)}`),
  },
  baselines: {
    list: (planId: string) => get<Baseline[]>(`/api/plans/${enc(planId)}/baselines`),
    tree: (planId: string) => get<BaselineTreeNode[]>(`/api/plans/${enc(planId)}/baselines/tree`),
    get: (id: string) => get<Baseline>(`/api/baselines/${enc(id)}`),
    create: (input: CreateBaselineInput) => post<Baseline>("/api/baselines", input),
    lock: (id: string, version: number) =>
      post<Baseline>(`/api/baselines/${enc(id)}/lock`, { version }),
    updateItem: (id: string, itemId: string, input: UpdateBaselineItemInput) =>
      put<Baseline>(`/api/baselines/${enc(id)}/items/${enc(itemId)}`, input),
    delete: (id: string) => del(`/api/baselines/${enc(id)}`),
    compare: (input: CompareBaselinesInput) =>
      post<BaselineComparison>("/api/baselines/compare", input),
  },
  changeRequests: {
    list: (planId: string) =>
      get<ChangeRequestWithApprovals[]>(`/api/plans/${enc(planId)}/change-requests`),
    create: (input: CreateChangeRequestInput) =>
      post<ChangeRequestWithApprovals>("/api/change-requests", input),
    withdraw: (id: string) => post<ChangeRequest>(`/api/change-requests/${enc(id)}/withdraw`),
    /** Pending approvals the user can decide; with `subprojects`, also of the project's subprojects. */
    pending: (projectId?: string, subprojects = false) =>
      get<PendingApproval[]>(
        `/api/approvals/pending${projectId ? `?projectId=${enc(projectId)}${subprojects ? "&subprojects=true" : ""}` : ""}`,
      ),
    forItem: (itemId: string) => get<TaskApprovalRequest[]>(`/api/items/${enc(itemId)}/approvals`),
    decide: (approvalId: string, input: DecideApprovalInput) =>
      post<ChangeRequestWithApprovals>(`/api/approvals/${enc(approvalId)}/decision`, input),
  },
  timelines: {
    list: (projectId: string) => get<Timeline[]>(`/api/projects/${enc(projectId)}/timelines`),
    get: (id: string) => get<Timeline>(`/api/timelines/${enc(id)}`),
    create: (projectId: string, input: CreateTimelineInput) =>
      post<Timeline>(`/api/projects/${enc(projectId)}/timelines`, input),
    update: (id: string, input: UpdateTimelineInput) =>
      patch<Timeline>(`/api/timelines/${enc(id)}`, input),
  },
  workspaces: {
    list: (projectId: string) => get<Workspace[]>(`/api/projects/${enc(projectId)}/workspaces`),
    create: (projectId: string, input: SaveWorkspaceInput) =>
      post<Workspace>(`/api/projects/${enc(projectId)}/workspaces`, input),
    update: (projectId: string, id: string, input: SaveWorkspaceInput) =>
      put<Workspace>(`/api/projects/${enc(projectId)}/workspaces/${enc(id)}`, input),
  },
  reports: {
    list: (projectId: string) => get<ReportDefinition[]>(`/api/projects/${enc(projectId)}/reports`),
    create: (projectId: string, input: ReportDefinitionInput) =>
      post<ReportDefinition>(`/api/projects/${enc(projectId)}/reports`, input),
    delete: (id: string) => del(`/api/reports/${enc(id)}`),
    /** Returns the generated file. */
    run: async (id: string, input: RunReportInput): Promise<Blob> => {
      const res = await fetch(`${apiUrl}/api/reports/${enc(id)}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as ApiErrorBody | null;
        throw new ApiError(
          res.status,
          err?.error.code ?? "HTTP",
          err?.error.message ?? res.statusText,
        );
      }
      return res.blob();
    },
  },
};
