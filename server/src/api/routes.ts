/** REST endpoints — a thin layer: parse input, call a service, return JSON. */
import { Router, type Request } from "express";
import { z } from "zod";
import {
  addReferenceInput,
  assignRoleInput,
  compareBaselinesInput,
  createBaselineInput,
  createChangeRequestInput,
  createDependencyInput,
  createPartyInput,
  createPlanInput,
  createProjectInput,
  createTaskInput,
  createTimelineInput,
  createUserInput,
  decideApprovalInput,
  moveReferenceInput,
  moveTaskInput,
  proposeTaskChangeInput,
  reorderTaskInput,
  changeTaskLevelInput,
  reportDefinitionInput,
  runReportInput,
  saveWorkspaceInput,
  userPreferencesSchema,
  setPredecessorsInput,
  setReferenceTypeInput,
  updateBaselineItemInput,
  updateProjectInput,
  updateTaskInput,
  updateTimelineInput,
} from "@planning/shared";
import type { Services } from "../services/Services.js";
import { ctxOf } from "./middleware.js";

const version = z.object({ version: z.number().int() });

const p = (req: Request, name: string): string => {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

const q = (req: Request, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === "string" && value ? value : undefined;
};

export function apiRoutes(s: Services): Router {
  const r = Router();

  // Users and parties
  r.get("/users", async (req, res) => void res.json(await s.users.list(ctxOf(req))));
  r.post("/users", async (req, res) => {
    const { passwordHash: _h, ...user } = await s.users.createUser(
      ctxOf(req),
      createUserInput.parse(req.body),
    );
    res.status(201).json(user);
  });
  r.put("/users/me/preferences", async (req, res) => {
    res.json(await s.users.setPreferences(ctxOf(req), userPreferencesSchema.parse(req.body)));
  });
  r.put("/users/:id/parties", async (req, res) => {
    const { partyIds } = z.object({ partyIds: z.array(z.string()) }).parse(req.body);
    res.json(await s.users.setUserParties(ctxOf(req), p(req, "id"), partyIds));
  });
  r.get("/parties", async (_req, res) => void res.json(await s.users.listParties()));
  r.post(
    "/parties",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.users.createParty(ctxOf(req), createPartyInput.parse(req.body))),
  );

  // Projects
  r.get("/projects", async (req, res) => void res.json(await s.projects.list(ctxOf(req))));
  r.post(
    "/projects",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.projects.create(ctxOf(req), createProjectInput.parse(req.body))),
  );
  r.get(
    "/projects/:id",
    async (req, res) => void res.json(await s.projects.get(ctxOf(req), p(req, "id"))),
  );
  r.patch(
    "/projects/:id",
    async (req, res) =>
      void res.json(
        await s.projects.update(ctxOf(req), p(req, "id"), updateProjectInput.parse(req.body)),
      ),
  );
  r.get(
    "/projects/:id/members",
    async (req, res) => void res.json(await s.projects.listMembers(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/projects/:id/members",
    async (req, res) =>
      void res
        .status(201)
        .json(
          await s.projects.assignRole(ctxOf(req), p(req, "id"), assignRoleInput.parse(req.body)),
        ),
  );
  r.delete("/projects/:id/members/:assignmentId", async (req, res) => {
    await s.projects.removeRole(ctxOf(req), p(req, "id"), p(req, "assignmentId"));
    res.status(204).end();
  });
  r.get(
    "/projects/:id/definitions",
    async (req, res) => void res.json(await s.projects.listDefinitions(ctxOf(req), p(req, "id"))),
  );
  r.patch("/definitions/:id", async (req, res) => {
    const changes = z
      .object({
        version: z.number().int(),
        name: z.string().min(1).optional(),
        acceptFrom: z.enum(["ESTIMATED", "CURRENT", "AGREED"]).optional(),
        requiresApproval: z.boolean().optional(),
        approvers: z
          .array(z.enum(["ADMIN", "PLAN_OWNER", "EDITOR", "APPROVER", "VIEWER"]))
          .optional(),
        externalItemRule: z.enum(["OWNER_ONLY", "OWNER_AND_RECIPIENTS"]).optional(),
        granularityOfAcceptance: z.enum(["ITEM", "BATCH", "WHOLE_PLAN"]).optional(),
        lockOnAccept: z.boolean().optional(),
        allowBranching: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(await s.projects.updateDefinition(ctxOf(req), p(req, "id"), changes));
  });
  r.get(
    "/projects/:id/audit",
    async (req, res) =>
      void res.json(await s.audit.list(ctxOf(req), p(req, "id"), q(req, "entityId"))),
  );

  // Plans
  r.get(
    "/projects/:id/dependency-issues",
    async (req, res) => void res.json(await s.plans.dependencyIssues(ctxOf(req), p(req, "id"))),
  );
  r.get(
    "/projects/:id/plans",
    async (req, res) => void res.json(await s.plans.list(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/projects/:id/plans",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.plans.create(ctxOf(req), p(req, "id"), createPlanInput.parse(req.body))),
  );
  r.get(
    "/plans/:id",
    async (req, res) => void res.json(await s.plans.get(ctxOf(req), p(req, "id"))),
  );
  r.delete("/plans/:id", async (req, res) => {
    await s.plans.delete(
      ctxOf(req),
      p(req, "id"),
      version.parse({ version: Number(q(req, "version")) }).version,
    );
    res.status(204).end();
  });
  r.patch(
    "/plans/:id",
    async (req, res) =>
      void res.json(
        await s.plans.update(
          ctxOf(req),
          p(req, "id"),
          createPlanInput.partial().extend(version.shape).parse(req.body),
        ),
      ),
  );
  r.get(
    "/plans/:id/view",
    async (req, res) => void res.json(await s.plans.getView(ctxOf(req), p(req, "id"))),
  );

  // Items, references, dependencies
  r.post(
    "/items",
    async (req, res) =>
      void res.status(201).json(await s.items.create(ctxOf(req), createTaskInput.parse(req.body))),
  );
  r.get(
    "/items/:id",
    async (req, res) => void res.json(await s.items.get(ctxOf(req), p(req, "id"))),
  );
  r.patch(
    "/items/:id",
    async (req, res) =>
      void res.json(
        await s.items.update(ctxOf(req), p(req, "id"), updateTaskInput.parse(req.body)),
      ),
  );
  r.post(
    "/items/:id/move",
    async (req, res) =>
      void res.json(await s.items.move(ctxOf(req), p(req, "id"), moveTaskInput.parse(req.body))),
  );
  r.post(
    "/items/:id/reorder",
    async (req, res) =>
      void res.json(
        await s.items.reorder(ctxOf(req), p(req, "id"), reorderTaskInput.parse(req.body)),
      ),
  );
  r.post(
    "/items/:id/level",
    async (req, res) =>
      void res.json(
        await s.items.changeLevel(ctxOf(req), p(req, "id"), changeTaskLevelInput.parse(req.body)),
      ),
  );
  r.put(
    "/items/:id/predecessors",
    async (req, res) =>
      void res.json(
        await s.items.setPredecessors(
          ctxOf(req),
          p(req, "id"),
          setPredecessorsInput.parse(req.body),
        ),
      ),
  );
  r.delete("/items/:id", async (req, res) => {
    await s.items.delete(
      ctxOf(req),
      p(req, "id"),
      version.parse({ version: Number(q(req, "version")) }).version,
    );
    res.status(204).end();
  });
  r.post(
    "/references",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.items.addReference(ctxOf(req), addReferenceInput.parse(req.body))),
  );
  r.get(
    "/items/:id/approvals",
    async (req, res) =>
      void res.json(await s.changeRequests.pendingForItem(ctxOf(req), p(req, "id"))),
  );
  r.get(
    "/items/:id/history",
    async (req, res) => void res.json(await s.audit.taskHistory(ctxOf(req), p(req, "id"))),
  );
  r.get(
    "/items/:id/reference-targets",
    async (req, res) => void res.json(await s.items.referenceTargets(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/references/:id/type",
    async (req, res) =>
      void res.json(
        await s.links.setReferenceType(
          ctxOf(req),
          p(req, "id"),
          setReferenceTypeInput.parse(req.body),
        ),
      ),
  );
  r.post(
    "/references/:id/move",
    async (req, res) =>
      void res.json(
        await s.items.moveReference(ctxOf(req), p(req, "id"), moveReferenceInput.parse(req.body)),
      ),
  );
  r.post(
    "/references/:id/reorder",
    async (req, res) =>
      void res.json(
        await s.items.reorderReference(ctxOf(req), p(req, "id"), reorderTaskInput.parse(req.body)),
      ),
  );
  r.post(
    "/references/:id/level",
    async (req, res) =>
      void res.json(
        await s.items.changeReferenceLevel(
          ctxOf(req),
          p(req, "id"),
          changeTaskLevelInput.parse(req.body),
        ),
      ),
  );
  r.post(
    "/references/:id/propose",
    async (req, res) =>
      void res
        .status(201)
        .json(
          await s.changeRequests.proposeTaskChange(
            ctxOf(req),
            p(req, "id"),
            proposeTaskChangeInput.parse(req.body),
          ),
        ),
  );
  r.delete("/references/:id", async (req, res) => {
    await s.items.removeReference(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });
  r.post(
    "/dependencies",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.items.createDependency(ctxOf(req), createDependencyInput.parse(req.body))),
  );
  r.delete("/dependencies/:id", async (req, res) => {
    await s.items.deleteDependency(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });

  // Links

  // Baselines
  r.get(
    "/plans/:id/baselines",
    async (req, res) => void res.json(await s.baselines.list(ctxOf(req), p(req, "id"))),
  );
  r.get(
    "/plans/:id/baselines/tree",
    async (req, res) => void res.json(await s.baselines.tree(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/baselines",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.baselines.create(ctxOf(req), createBaselineInput.parse(req.body))),
  );
  r.post(
    "/baselines/compare",
    async (req, res) =>
      void res.json(await s.baselines.compare(ctxOf(req), compareBaselinesInput.parse(req.body))),
  );
  r.get(
    "/baselines/:id",
    async (req, res) => void res.json(await s.baselines.get(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/baselines/:id/lock",
    async (req, res) =>
      void res.json(
        await s.baselines.lock(ctxOf(req), p(req, "id"), version.parse(req.body).version),
      ),
  );
  r.put(
    "/baselines/:id/items/:itemId",
    async (req, res) =>
      void res.json(
        await s.baselines.updateBranchItem(
          ctxOf(req),
          p(req, "id"),
          p(req, "itemId"),
          updateBaselineItemInput.parse(req.body),
        ),
      ),
  );
  r.delete("/baselines/:id", async (req, res) => {
    await s.baselines.delete(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });

  // Change requests and approvals
  r.get(
    "/plans/:id/change-requests",
    async (req, res) => void res.json(await s.changeRequests.list(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/change-requests",
    async (req, res) =>
      void res
        .status(201)
        .json(await s.changeRequests.create(ctxOf(req), createChangeRequestInput.parse(req.body))),
  );
  r.get(
    "/change-requests/:id",
    async (req, res) => void res.json(await s.changeRequests.get(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/change-requests/:id/withdraw",
    async (req, res) => void res.json(await s.changeRequests.withdraw(ctxOf(req), p(req, "id"))),
  );
  r.get(
    "/approvals/pending",
    async (req, res) =>
      void res.json(
        await s.changeRequests.listPending(
          ctxOf(req),
          q(req, "projectId"),
          q(req, "subprojects") === "true",
        ),
      ),
  );
  r.post(
    "/approvals/:id/decision",
    async (req, res) =>
      void res.json(
        await s.changeRequests.decide(
          ctxOf(req),
          p(req, "id"),
          decideApprovalInput.parse(req.body),
        ),
      ),
  );

  // Timelines and workspaces
  r.get(
    "/projects/:id/timelines",
    async (req, res) => void res.json(await s.timelines.list(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/projects/:id/timelines",
    async (req, res) =>
      void res
        .status(201)
        .json(
          await s.timelines.create(ctxOf(req), p(req, "id"), createTimelineInput.parse(req.body)),
        ),
  );
  r.get(
    "/timelines/:id",
    async (req, res) => void res.json(await s.timelines.get(ctxOf(req), p(req, "id"))),
  );
  r.patch(
    "/timelines/:id",
    async (req, res) =>
      void res.json(
        await s.timelines.update(ctxOf(req), p(req, "id"), updateTimelineInput.parse(req.body)),
      ),
  );
  r.delete("/timelines/:id", async (req, res) => {
    await s.timelines.delete(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });
  r.get(
    "/projects/:id/workspaces",
    async (req, res) => void res.json(await s.workspaces.list(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/projects/:id/workspaces",
    async (req, res) =>
      void res
        .status(201)
        .json(
          await s.workspaces.save(
            ctxOf(req),
            p(req, "id"),
            null,
            saveWorkspaceInput.parse(req.body),
          ),
        ),
  );
  r.put(
    "/projects/:id/workspaces/:workspaceId",
    async (req, res) =>
      void res.json(
        await s.workspaces.save(
          ctxOf(req),
          p(req, "id"),
          p(req, "workspaceId"),
          saveWorkspaceInput.parse(req.body),
        ),
      ),
  );
  r.delete("/workspaces/:id", async (req, res) => {
    await s.workspaces.delete(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });

  // Reports
  r.get(
    "/projects/:id/reports",
    async (req, res) => void res.json(await s.reports.list(ctxOf(req), p(req, "id"))),
  );
  r.post(
    "/projects/:id/reports",
    async (req, res) =>
      void res
        .status(201)
        .json(
          await s.reports.create(ctxOf(req), p(req, "id"), reportDefinitionInput.parse(req.body)),
        ),
  );
  r.get(
    "/reports/:id",
    async (req, res) => void res.json(await s.reports.get(ctxOf(req), p(req, "id"))),
  );
  r.put(
    "/reports/:id",
    async (req, res) =>
      void res.json(
        await s.reports.update(
          ctxOf(req),
          p(req, "id"),
          reportDefinitionInput.extend(version.shape).parse(req.body),
        ),
      ),
  );
  r.delete("/reports/:id", async (req, res) => {
    await s.reports.delete(ctxOf(req), p(req, "id"));
    res.status(204).end();
  });
  r.post("/reports/:id/run", async (req, res) => {
    const result = await s.reports.run(
      ctxOf(req),
      p(req, "id"),
      runReportInput.parse(req.body ?? {}),
    );
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.send(result.encoding === "base64" ? Buffer.from(result.body, "base64") : result.body);
  });

  return r;
}
