/** Business rules end-to-end through the services, on both backends (CLAUDE.md §11). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  RuleViolationError,
  ValidationError,
} from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { serviceBackends } from "../testing/backends.js";
import { type Fixture, MONDAY, createFixture } from "../testing/fixture.js";
import { findTrackBaseline } from "./lookups.js";

describe.each(serviceBackends)("services on $name", (backend) => {
  let storage: StorageAdapter;
  let cleanup: () => Promise<void>;
  let f: Fixture;

  beforeEach(async () => {
    ({ storage, cleanup } = await backend.create());
    f = await createFixture(storage);
  });
  afterEach(async () => cleanup());

  const track = (planId: string, t: "CURRENT" | "AGREED") => findTrackBaseline(storage, planId, t);

  /** Accept items of plan A into Current (alice owns A). */
  async function acceptToCurrent(planId: string, itemIds: string[], ctx = f.alice) {
    const { approvals } = await f.services.changeRequests.create(ctx, {
      planId,
      targetTrack: "CURRENT",
      itemIds,
      sourceBaselineId: null,
      title: "To current",
      description: "",
    });
    for (const a of approvals)
      await f.services.changeRequests.decide(ctx, a.id, { decision: "APPROVE", comment: "" });
  }

  /** External item in A, referenced by B and accepted into Current of both plans. */
  async function sharedItem() {
    const item = await f.task("Interface delivery", { ownership: "EXTERNAL" });
    const ref = await f.services.items.addReference(f.bob, { itemId: item.id, planId: f.planB.id });
    await acceptToCurrent(f.planA.id, [item.id]);
    await acceptToCurrent(f.planB.id, [item.id], f.bob);
    return { item, ref };
  }

  describe("projects and plans", () => {
    it("keeps a user's preferences across sign-ins, for that user only", async () => {
      expect((await f.services.users.get(f.alice.user.id))?.preferences).toBeUndefined();
      const prefs = { expandedProjectIds: [f.project.id] };
      expect((await f.services.users.setPreferences(f.alice, prefs)).preferences).toEqual(prefs);
      expect((await f.services.users.get(f.alice.user.id))?.preferences).toEqual(prefs);
      expect((await f.services.users.get(f.bob.user.id))?.preferences).toBeUndefined();
      // Other changes to the user keep the preferences.
      await f.services.users.setUserParties(f.admin, f.alice.user.id, []);
      expect((await f.services.users.get(f.alice.user.id))?.preferences).toEqual(prefs);
    });

    it("creates default definitions, tracks and roles", async () => {
      const defs = await f.services.projects.listDefinitions(f.admin, f.project.id);
      expect(defs.map((d) => d.track).sort()).toEqual(["AGREED", "CURRENT", "ESTIMATED"]);
      expect((await track(f.planA.id, "CURRENT"))?.items).toEqual([]);
      expect((await track(f.planA.id, "AGREED"))?.kind).toBe("TRACK");
      const view = await f.services.plans.getView(f.alice, f.planA.id);
      expect(view.myRoles).toContain("PLAN_OWNER");
      expect(view.trackBaselineIds.CURRENT).not.toBeNull();
    });

    it("keeps a system admin's plan roles, so an admin who owns a plan can approve", async () => {
      const t = await f.services.items.create(f.admin, {
        planId: f.planA.id,
        parentId: null,
        name: "T",
        start: MONDAY,
        duration: 1,
        granularity: "days",
        notes: "",
        ownership: "INTERNAL",
      });
      expect(await f.services.access.roles(f.admin.user, f.project.id, f.planA.id)).toEqual([
        "ADMIN",
        "PLAN_OWNER",
      ]);
      const { approvals } = await f.services.changeRequests.create(f.admin, {
        planId: f.planA.id,
        targetTrack: "CURRENT",
        itemIds: [t.id],
        sourceBaselineId: null,
        title: "c",
        description: "",
      });
      expect(
        (await f.services.changeRequests.listPending(f.admin)).map((p) => p.approval.id),
      ).toEqual(approvals.map((a) => a.id));
    });

    it("edits name, type, description, parent and active state", async () => {
      const program = await f.services.projects.create(f.admin, {
        name: "Program",
        projectType: "Portfolio",
        description: "",
        parentProjectId: null,
      });
      expect(program).toMatchObject({ parentProjectId: null, active: true });
      const moved = await f.services.projects.update(f.admin, f.project.id, {
        version: f.project.version,
        name: "Apollo II",
        projectType: "Contract",
        description: "Second phase",
        parentProjectId: program.id,
        active: false,
      });
      expect(moved).toMatchObject({
        name: "Apollo II",
        projectType: "Contract",
        description: "Second phase",
        parentProjectId: program.id,
        active: false,
      });
      const listed = await f.services.projects.list(f.admin);
      expect(listed.find((p) => p.id === f.project.id)).toMatchObject({
        active: false,
        canEdit: true,
      });
      // The parent cannot move under its own subproject.
      await expect(
        f.services.projects.update(f.admin, program.id, {
          version: program.version,
          parentProjectId: f.project.id,
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("requires admin rights on the parent to add a subproject", async () => {
      // Alice owns plan A but is not an admin of the project.
      expect((await f.services.projects.list(f.alice))[0]?.canEdit).toBe(false);
      await expect(
        f.services.projects.create(f.alice, {
          name: "Side project",
          projectType: "",
          description: "",
          parentProjectId: f.project.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const own = await f.services.projects.create(f.alice, {
        name: "Side project",
        projectType: "",
        description: "",
        parentProjectId: null,
      });
      await expect(
        f.services.projects.update(f.alice, own.id, {
          version: own.version,
          parentProjectId: f.project.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("reads projects stored without the hierarchy fields", async () => {
      const { parentProjectId: _p, projectType: _t, active: _a, ...legacy } = f.project;
      await storage.save("project", { ...legacy, id: "legacy-project", version: 0 } as never);
      expect(await f.services.projects.get(f.admin, "legacy-project")).toMatchObject({
        parentProjectId: null,
        projectType: "",
        active: true,
      });
    });

    it("keeps a workspace's view state per user and project", async () => {
      const created = await f.services.workspaces.save(f.alice, f.project.id, null, {
        name: "Default",
        layout: { panels: 1 },
        viewState: { expandedProjectIds: [f.project.id] },
      });
      // Saving only the layout keeps the view state.
      const updated = await f.services.workspaces.save(f.alice, f.project.id, created.id, {
        version: created.version,
        name: "Default",
        layout: { panels: 2 },
      });
      expect(updated.viewState).toEqual({ expandedProjectIds: [f.project.id] });
      const [listed] = await f.services.workspaces.list(f.alice, f.project.id);
      expect(listed).toMatchObject({ layout: { panels: 2 }, viewState: updated.viewState });
      expect(await f.services.workspaces.list(f.bob, f.project.id)).toEqual([]);
    });

    it("renames a plan and deletes it with everything that belongs only to it", async () => {
      const renamed = await f.services.plans.update(f.alice, f.planA.id, {
        version: f.planA.version,
        name: "Contract v2",
        planType: "contract",
      });
      expect(renamed).toMatchObject({ name: "Contract v2", planType: "contract" });
      const a = await f.task("A");
      const b = await f.task("B");
      await f.services.items.setPredecessors(f.alice, b.id, { predecessors: "1" });
      await acceptToCurrent(f.planA.id, [a.id]); // resolved request + unlocked track
      const tl = await f.services.timelines.create(f.alice, f.project.id, {
        name: "Roadmap",
        start: MONDAY,
        end: "2026-12-31T00:00:00.000Z",
        scale: "months",
        rows: [{ id: "r1", name: "Row" }],
      });
      await f.services.timelines.update(f.alice, tl.id, {
        version: tl.version,
        entries: [
          { id: "e1", rowId: "r1", itemId: a.id, planId: f.planA.id, placement: "on", line: 0 },
        ],
      });
      const def = await f.services.reports.create(f.alice, f.project.id, {
        name: "Status",
        planIds: [f.planA.id, f.planB.id],
        timelineIds: [],
        baselineIds: [],
        rangeStart: null,
        rangeEnd: null,
        granularity: "days",
        filter: {},
      });

      // Only the plan's owners (and admins) may delete it.
      await expect(
        f.services.plans.delete(f.bob, f.planA.id, renamed.version),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await f.services.plans.delete(f.alice, f.planA.id, renamed.version);
      expect(await storage.get("plan", f.planA.id)).toBeNull();
      expect(await storage.query("task", { projectId: f.project.id, planId: f.planA.id })).toEqual(
        [],
      );
      expect(await storage.query("dependency", { toItemId: b.id })).toEqual([]);
      expect(
        await storage.query("baseline", { projectId: f.project.id, planId: f.planA.id }),
      ).toEqual([]);
      expect((await storage.get("timeline", tl.id))?.entries).toEqual([]);
      expect((await storage.get("reportDefinition", def.id))?.planIds).toEqual([f.planB.id]);
      const audit = await f.services.audit.list(f.admin, f.project.id, f.planA.id);
      expect(audit.map((e) => e.action)).toContain("delete");
    });

    it("refuses to delete a plan whose tasks are used elsewhere, with open requests or history", async () => {
      const used = await f.task("Shared", { ownership: "EXTERNAL" });
      const ref = await f.services.items.addReference(f.bob, {
        itemId: used.id,
        planId: f.planB.id,
      });
      const del = async (ctx = f.alice, planId = f.planA.id) =>
        f.services.plans.delete(ctx, planId, (await storage.get("plan", planId))!.version);
      await expect(del()).rejects.toThrow(`used in other plans (${f.planB.name})`);
      await f.services.items.removeReference(f.bob, ref.id);

      const { changeRequest } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "CURRENT",
        itemIds: [used.id],
        sourceBaselineId: null,
        title: "Open",
        description: "",
      });
      await expect(del()).rejects.toThrow(/still open/);
      await f.services.changeRequests.withdraw(f.alice, changeRequest.id);

      await f.services.baselines.create(f.alice, {
        planId: f.planA.id,
        name: "Q1",
        kind: "SNAPSHOT",
        fromBaselineId: null,
        lock: true,
      });
      await expect(del()).rejects.toThrow(/locked baseline/);

      // A plan that only uses other plans' tasks can go; its uses go with it.
      const other = await f.task("Other", { ownership: "EXTERNAL" });
      await f.services.items.addReference(f.bob, { itemId: other.id, planId: f.planB.id });
      await del(f.bob, f.planB.id);
      expect(await storage.query("planItemReference", { itemId: other.id })).toEqual([]);
    });

    it("enforces access control", async () => {
      await expect(f.services.plans.getView(f.outsider, f.planA.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        f.services.items.create(f.carol, {
          planId: f.planA.id,
          parentId: null,
          name: "x",
          start: MONDAY,
          duration: 1,
          granularity: "days",
          notes: "",
          ownership: "INTERNAL",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        f.task("bob cannot edit A", { planId: f.planA.id }).then(() =>
          f.services.items.create(f.bob, {
            planId: f.planA.id,
            parentId: null,
            name: "x",
            start: MONDAY,
            duration: 1,
            granularity: "days",
            notes: "",
            ownership: "INTERNAL",
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await f.services.projects.list(f.outsider)).toEqual([]);
      expect((await f.services.projects.list(f.carol)).map((p) => p.id)).toEqual([f.project.id]);
    });
  });

  describe("items", () => {
    it("numbers tasks per plan and keeps the numbers when tasks move or are deleted", async () => {
      const t1 = await f.task("One");
      const t2 = await f.task("Two");
      const b1 = await f.task("Other plan", { planId: f.planB.id });
      expect([t1.taskNumber, t2.taskNumber, b1.taskNumber]).toEqual([1, 2, 1]);
      await f.services.items.delete(f.alice, t1.id, t1.version);
      expect((await f.task("Three")).taskNumber).toBe(3);
    });

    it("indents a task under the task above and outdents it back after its parent", async () => {
      const a = await f.task("A");
      const b = await f.task("B");
      await f.task("C");
      const level = async (id: string, direction: "indent" | "outdent") =>
        f.services.items.changeLevel(f.alice, id, {
          version: (await f.services.items.get(f.alice, id)).version,
          direction,
        });
      const topLevel = async () =>
        (await f.services.plans.getView(f.alice, f.planA.id)).items
          .filter((t) => t.parentId === null)
          .sort((x, y) => x.sortOrder - y.sortOrder)
          .map((t) => t.name);

      expect((await level(b.id, "indent")).parentId).toBe(a.id);
      const view = await f.services.plans.getView(f.alice, f.planA.id);
      expect(view.kinds[a.id]).toBe("activity");
      expect(await topLevel()).toEqual(["A", "C"]);

      expect((await level(b.id, "outdent")).parentId).toBeNull();
      expect(await topLevel()).toEqual(["A", "B", "C"]);
      expect((await f.services.plans.getView(f.alice, f.planA.id)).kinds[a.id]).toBe("task");

      await expect(level(a.id, "indent")).rejects.toBeInstanceOf(RuleViolationError);
      await expect(level(a.id, "outdent")).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("refuses to indent under a milestone or under a task it is linked to", async () => {
      await f.task("Gate", { duration: 0 });
      const after = await f.task("After");
      await expect(
        f.services.items.changeLevel(f.alice, after.id, {
          version: after.version,
          direction: "indent",
        }),
      ).rejects.toThrow(/milestone/);

      const first = await f.task("First");
      const second = await f.task("Second");
      await f.services.items.setPredecessors(f.alice, second.id, {
        predecessors: String(first.taskNumber),
      });
      const fresh = await f.services.items.get(f.alice, second.id);
      await expect(
        f.services.items.changeLevel(f.alice, second.id, {
          version: fresh.version,
          direction: "indent",
        }),
      ).rejects.toThrow(/linked/);
    });

    it("moves tasks up and down among their siblings", async () => {
      const a = await f.task("A");
      const b = await f.task("B");
      const c = await f.task("C");
      await f.services.items.reorder(f.alice, c.id, { version: c.version, direction: "up" });
      const names = async () =>
        (await f.services.plans.getView(f.alice, f.planA.id)).items.map((t) => t.name);
      expect(await names()).toEqual(["A", "C", "B"]);
      const fresh = (await f.services.items.get(f.alice, a.id)).version;
      await f.services.items.reorder(f.alice, a.id, { version: fresh, direction: "down" });
      expect(await names()).toEqual(["C", "A", "B"]);
      // Already last: nothing changes.
      const last = await f.services.items.get(f.alice, b.id);
      await f.services.items.reorder(f.alice, b.id, { version: last.version, direction: "down" });
      expect(await names()).toEqual(["C", "A", "B"]);
    });

    it("sets predecessors from notation with type, lag and lead", async () => {
      const t1 = await f.task("Design");
      const t2 = await f.task("Build");
      const t3 = await f.task("Test");
      const set = (text: string) =>
        f.services.items.setPredecessors(f.alice, t3.id, { predecessors: text });
      const deps = await set(`${t1.taskNumber}FS+3d; ${t2.taskNumber}SS-1w`);
      expect(
        deps.map(({ fromItemId, type, lag, lagUnit }) => ({ fromItemId, type, lag, lagUnit })),
      ).toEqual(
        expect.arrayContaining([
          { fromItemId: t1.id, type: "FS", lag: 3, lagUnit: "days" },
          { fromItemId: t2.id, type: "SS", lag: -1, lagUnit: "weeks" },
        ]),
      );
      // Changing the lag updates in place; leaving one out removes it; no unit = task granularity.
      const kept = deps.find((d) => d.fromItemId === t1.id)!;
      const after = await set(`${t1.taskNumber}FS+2`);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: kept.id, lag: 2, lagUnit: "days" });
      expect(await set("")).toEqual([]);
    });

    it("reports dependencies whose successor starts too early, allowing slack", async () => {
      const design = await f.task("Design", { duration: 5 });
      const build = await f.task("Build", { duration: 2 }); // starts with Design: too early
      const [dep] = await f.services.items.setPredecessors(f.alice, build.id, {
        predecessors: `${design.taskNumber}FS`,
      });
      const view = await f.services.plans.getView(f.alice, f.planA.id);
      expect(view.dependencyIssues).toEqual([
        { dependencyId: dep!.id, required: design.end, actual: build.start },
      ]);
      // The project summary lists it per plan, with names.
      const summary = await f.services.plans.dependencyIssues(f.admin, f.project.id);
      expect(summary.find((p) => p.planId === f.planA.id)?.issues).toEqual([
        expect.objectContaining({
          dependencyId: dep!.id,
          fromName: "Design",
          toName: "Build",
          type: "FS",
        }),
      ]);
      expect(summary.find((p) => p.planId === f.planB.id)?.issues).toEqual([]);
      // Moving Build after Design (with slack) resolves it.
      await f.services.items.move(f.alice, build.id, {
        version: (await f.services.items.get(f.alice, build.id)).version,
        start: "2026-01-19T00:00:00.000Z",
      });
      expect((await f.services.plans.getView(f.alice, f.planA.id)).dependencyIssues).toEqual([]);
    });

    it("rejects unknown task numbers, loops and links to the task's own activity", async () => {
      const parent = await f.task("Phase");
      const child = await f.task("Work", { parentId: parent.id });
      const other = await f.task("Other");
      const set = (taskId: string, text: string) =>
        f.services.items.setPredecessors(f.alice, taskId, { predecessors: text });
      await expect(set(other.id, "99")).rejects.toBeInstanceOf(ValidationError);
      await expect(set(other.id, "4XX")).rejects.toBeInstanceOf(ValidationError);
      await expect(set(child.id, String(parent.taskNumber))).rejects.toBeInstanceOf(
        RuleViolationError,
      );
      await set(other.id, String(child.taskNumber));
      await expect(set(child.id, String(other.taskNumber))).rejects.toBeInstanceOf(
        RuleViolationError,
      );
      // The same loop is refused when drawn in the Gantt.
      await expect(
        f.services.items.createDependency(f.alice, {
          fromItemId: other.id,
          toItemId: child.id,
          type: "SS",
          lag: 0,
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("derives kinds and rolls up activities", async () => {
      const parent = await f.task("Phase 1");
      await f.task("Design", { parentId: parent.id, duration: 3 });
      await f.task("Build", {
        parentId: parent.id,
        duration: 4,
        start: "2026-01-12T00:00:00.000Z",
      });
      const milestone = await f.task("Go-live", { duration: 0 });
      const view = await f.services.plans.getView(f.alice, f.planA.id);
      expect(view.kinds[parent.id]).toBe("activity");
      expect(view.kinds[milestone.id]).toBe("milestone");
      const rolled = view.items.find((i) => i.id === parent.id)!;
      expect(rolled.start).toBe(MONDAY);
      expect(rolled.end).toBe("2026-01-16T00:00:00.000Z");
      expect(rolled.duration).toBe(9);
    });

    it("rejects subtasks under milestones and direct edits of activity dates", async () => {
      const milestone = await f.task("M", { duration: 0 });
      await expect(f.task("child", { parentId: milestone.id })).rejects.toBeInstanceOf(
        RuleViolationError,
      );
      const activity = await f.task("A");
      await f.task("child", { parentId: activity.id });
      const fresh = await f.services.items.get(f.alice, activity.id);
      await expect(
        f.services.items.update(f.alice, activity.id, { version: fresh.version, duration: 2 }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("moves an activity together with its subtasks", async () => {
      const activity = await f.task("A");
      const child = await f.task("child", { parentId: activity.id, duration: 2 });
      const fresh = await f.services.items.get(f.alice, activity.id);
      await f.services.items.move(f.alice, activity.id, {
        version: fresh.version,
        start: "2026-01-12T00:00:00.000Z",
      });
      expect((await f.services.items.get(f.alice, child.id)).start).toBe(
        "2026-01-12T00:00:00.000Z",
      );
      expect((await f.services.items.get(f.alice, activity.id)).start).toBe(
        "2026-01-12T00:00:00.000Z",
      );
    });

    it("uses optimistic locking", async () => {
      const t = await f.task("T");
      await f.services.items.update(f.alice, t.id, { version: t.version, name: "T2" });
      await expect(
        f.services.items.update(f.alice, t.id, { version: t.version, name: "T3" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("only allows references to external items, resolved live", async () => {
      const internal = await f.task("Internal");
      await expect(
        f.services.items.addReference(f.bob, { itemId: internal.id, planId: f.planB.id }),
      ).rejects.toBeInstanceOf(RuleViolationError);
      const external = await f.task("External", { ownership: "EXTERNAL" });
      await f.services.items.addReference(f.bob, { itemId: external.id, planId: f.planB.id });
      await f.services.items.update(f.alice, external.id, {
        version: external.version,
        duration: 8,
      });
      const view = await f.services.plans.getView(f.bob, f.planB.id);
      expect(view.references[0]?.item.duration).toBe(8);
      expect(view.references[0]?.linkType).toBe("MONITOR");
    });
  });

  describe("acceptance workflow", () => {
    it("accepts Estimated → Current after the plan owner approves, with an audit trail", async () => {
      const t = await f.task("T");
      const { changeRequest, approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "CURRENT",
        itemIds: [t.id],
        sourceBaselineId: null,
        title: "Commit",
        description: "",
      });
      expect(changeRequest.status).toBe("PENDING");
      expect(approvals.map((a) => a.planId)).toEqual([f.planA.id]);
      expect((await track(f.planA.id, "CURRENT"))?.items).toEqual([]);
      await expect(
        f.services.changeRequests.decide(f.bob, approvals[0]!.id, {
          decision: "APPROVE",
          comment: "",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const result = await f.services.changeRequests.decide(f.alice, approvals[0]!.id, {
        decision: "APPROVE",
        comment: "ok",
      });
      expect(result.changeRequest.status).toBe("APPROVED");
      expect((await track(f.planA.id, "CURRENT"))?.items.map((i) => i.itemId)).toEqual([t.id]);
      const audit = await f.services.audit.list(f.alice, f.project.id, changeRequest.id);
      expect(audit.map((a) => a.action)).toEqual(["create", "accept"]);
    });

    it("requires owner and all recipients to approve external items into Agreed", async () => {
      const { item, ref } = await sharedItem();
      const { changeRequest, approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [item.id],
        sourceBaselineId: null,
        title: "Agree",
        description: "",
      });
      expect(approvals.map((a) => a.planId).sort()).toEqual([f.planA.id, f.planB.id].sort());
      expect((await f.services.items.get(f.alice, item.id)).agreementState).toBe("PROPOSED");

      const forA = approvals.find((a) => a.planId === f.planA.id)!;
      const forB = approvals.find((a) => a.planId === f.planB.id)!;
      expect(
        (
          await f.services.changeRequests.decide(f.alice, forA.id, {
            decision: "APPROVE",
            comment: "",
          })
        ).changeRequest.status,
      ).toBe("PENDING");
      expect(
        (await f.services.changeRequests.listPending(f.bob)).map((p) => p.approval.id),
      ).toEqual([forB.id]);
      expect(
        (
          await f.services.changeRequests.decide(f.bob, forB.id, {
            decision: "APPROVE",
            comment: "",
          })
        ).changeRequest.status,
      ).toBe("APPROVED");

      expect((await track(f.planA.id, "AGREED"))?.items.map((i) => i.itemId)).toEqual([item.id]);
      expect((await track(f.planB.id, "AGREED"))?.items[0]).toMatchObject({
        itemId: item.id,
        isReference: true,
      });
      expect((await f.services.items.get(f.alice, item.id)).agreementState).toBe("AGREED");
      expect((await storage.get("planItemReference", ref.id))?.agreementState).toBe("AGREED");
      // lockOnAccept keeps a locked snapshot of the accepted track.
      const snapshots = (await f.services.baselines.list(f.alice, f.planA.id)).filter(
        (b) => b.kind === "SNAPSHOT",
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.locked).toBe(true);
      expect(changeRequest.itemIds).toEqual([item.id]);
    });

    it("keeps a rejected external item in the recipient's Current with state REJECTED", async () => {
      const { item, ref } = await sharedItem();
      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [item.id],
        sourceBaselineId: null,
        title: "Agree",
        description: "",
      });
      const forB = approvals.find((a) => a.planId === f.planB.id)!;
      const result = await f.services.changeRequests.decide(f.bob, forB.id, {
        decision: "REJECT",
        comment: "too late",
      });
      expect(result.changeRequest.status).toBe("REJECTED");
      expect((await track(f.planB.id, "CURRENT"))?.items.map((i) => i.itemId)).toEqual([item.id]);
      expect((await track(f.planB.id, "AGREED"))?.items).toEqual([]);
      expect((await storage.get("planItemReference", ref.id))?.agreementState).toBe("REJECTED");
      expect((await f.services.items.get(f.alice, item.id)).agreementState).toBe("REJECTED");

      // The rejected state is kept until the item changes.
      const fresh = await f.services.items.get(f.alice, item.id);
      await f.services.items.update(f.alice, item.id, { version: fresh.version, duration: 6 });
      expect((await storage.get("planItemReference", ref.id))?.agreementState).toBe("NONE");
      expect((await f.services.items.get(f.alice, item.id)).agreementState).toBe("NONE");
    });

    it("supersedes an open change request when the item changes", async () => {
      const t = await f.task("T");
      const { changeRequest } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "CURRENT",
        itemIds: [t.id],
        sourceBaselineId: null,
        title: "c",
        description: "",
      });
      await f.services.items.update(f.alice, t.id, { version: t.version, name: "renamed" });
      expect(
        (await f.services.changeRequests.get(f.alice, changeRequest.id)).changeRequest.status,
      ).toBe("SUPERSEDED");
      expect(await f.services.changeRequests.listPending(f.alice)).toEqual([]);
    });

    it("rejects approvals that originate from MCP, but allows creating requests", async () => {
      const t = await f.task("T");
      const mcp = { ...f.alice, origin: "MCP" as const };
      const { changeRequest, approvals } = await f.services.changeRequests.create(mcp, {
        planId: f.planA.id,
        targetTrack: "CURRENT",
        itemIds: [t.id],
        sourceBaselineId: null,
        title: "from agent",
        description: "",
      });
      expect(changeRequest.origin).toBe("MCP");
      await expect(
        f.services.changeRequests.decide(mcp, approvals[0]!.id, {
          decision: "APPROVE",
          comment: "",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(
        (await f.services.changeRequests.get(f.alice, changeRequest.id)).changeRequest.status,
      ).toBe("PENDING");
    });

    it("accepts atomically: a failure leaves everything unchanged", async () => {
      const { item } = await sharedItem();
      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [item.id],
        sourceBaselineId: null,
        title: "Agree",
        description: "",
      });
      await f.services.changeRequests.decide(
        f.alice,
        approvals.find((a) => a.planId === f.planA.id)!.id,
        { decision: "APPROVE", comment: "" },
      );
      // Break the recipient's Agreed track so the final acceptance step fails.
      const bAgreed = (await track(f.planB.id, "AGREED"))!;
      await storage.delete("baseline", bAgreed.id, bAgreed.version);
      const forB = approvals.find((a) => a.planId === f.planB.id)!;
      await expect(
        f.services.changeRequests.decide(f.bob, forB.id, { decision: "APPROVE", comment: "" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await storage.get("approval", forB.id))?.status).toBe("PENDING");
      expect((await track(f.planA.id, "AGREED"))?.items).toEqual([]);
    });

    it("enforces the definition's acceptance granularity", async () => {
      const a = await f.task("a");
      const b = await f.task("b");
      await acceptToCurrent(f.planA.id, [a.id, b.id]);
      await expect(
        f.services.changeRequests.create(f.alice, {
          planId: f.planA.id,
          targetTrack: "AGREED",
          itemIds: [a.id, b.id],
          sourceBaselineId: null,
          title: "x",
          description: "",
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
      await expect(
        f.services.changeRequests.create(f.alice, {
          planId: f.planA.id,
          targetTrack: "AGREED",
          itemIds: [(await f.task("not current")).id],
          sourceBaselineId: null,
          title: "x",
          description: "",
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("lets a party representative approve on an AGREEMENT link", async () => {
      const party = await f.services.users.createParty(f.admin, {
        name: "Supplier",
        description: "",
      });
      await f.services.users.setUserParties(f.admin, f.carol.user.id, [party.id]);
      const carol = { ...f.carol, user: (await storage.get("user", f.carol.user.id))! };
      const { item, ref } = await sharedItem();
      await f.services.links.setReferenceType(f.admin, ref.id, {
        type: "AGREEMENT",
        partyIds: [party.id],
      });
      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [item.id],
        sourceBaselineId: null,
        title: "Agree",
        description: "",
      });
      const forParty = approvals.find((a) => a.partyId === party.id)!;
      expect(forParty).toBeDefined();
      await f.services.changeRequests.decide(carol, forParty.id, {
        decision: "APPROVE",
        comment: "",
      });
      expect((await storage.get("approval", forParty.id))?.status).toBe("APPROVED");
    });
  });

  describe("references in the recipient hierarchy", () => {
    /** External task in A, used in B (bob) under a local activity of B. */
    async function placedReference() {
      const external = await f.task("Interface delivery", {
        ownership: "EXTERNAL",
        start: "2026-02-02T00:00:00.000Z",
        duration: 5,
      });
      const phase = await f.task("Integration", { planId: f.planB.id });
      await f.task("Local test", { planId: f.planB.id, parentId: phase.id, duration: 2 });
      const ref = await f.services.items.addReference(f.bob, {
        itemId: external.id,
        planId: f.planB.id,
      });
      const placed = await f.services.items.moveReference(f.bob, ref.id, {
        version: ref.version,
        parentId: phase.id,
      });
      return { external, phase, ref: placed };
    }

    it("places a reference under a local task, which rolls up the referenced dates", async () => {
      const { external, phase, ref } = await placedReference();
      expect(ref.parentId).toBe(phase.id);
      const view = await f.services.plans.getView(f.bob, f.planB.id);
      expect(view.kinds[phase.id]).toBe("activity");
      const rolled = view.items.find((t) => t.id === phase.id)!;
      expect(rolled.start).toBe(MONDAY);
      expect(rolled.end).toBe(external.end);
      // The owner moves the task: the recipient's activity follows.
      await f.services.items.move(f.alice, external.id, {
        version: external.version,
        start: "2026-03-02T00:00:00.000Z",
      });
      const moved = await f.services.items.get(f.alice, external.id);
      expect((await f.services.items.get(f.bob, phase.id)).end).toBe(moved.end);
      // The local activity cannot be deleted while the reference sits under it.
      const fresh = await f.services.items.get(f.bob, phase.id);
      await expect(f.services.items.delete(f.bob, phase.id, fresh.version)).rejects.toBeInstanceOf(
        RuleViolationError,
      );
    });

    it("indents and outdents a reference among the plan's local tasks", async () => {
      const phase = await f.task("Phase", { planId: f.planB.id });
      const external = await f.task("Shared", { ownership: "EXTERNAL" });
      const ref = await f.services.items.addReference(f.bob, {
        itemId: external.id,
        planId: f.planB.id,
      });
      const indented = await f.services.items.changeReferenceLevel(f.bob, ref.id, {
        version: ref.version,
        direction: "indent",
      });
      expect(indented.parentId).toBe(phase.id);
      expect((await f.services.plans.getView(f.bob, f.planB.id)).kinds[phase.id]).toBe("activity");
      const outdented = await f.services.items.changeReferenceLevel(f.bob, ref.id, {
        version: indented.version,
        direction: "outdent",
      });
      expect(outdented.parentId).toBeNull();
      // Nothing can be placed under a reference.
      const local = await f.task("Local", { planId: f.planB.id });
      await expect(
        f.services.items.changeLevel(f.bob, local.id, {
          version: local.version,
          direction: "indent",
        }),
      ).rejects.toThrow(/another plan/);
    });

    it("orders references together with local tasks and refuses milestone parents", async () => {
      const a = await f.task("A", { planId: f.planB.id });
      const external = await f.task("Shared", { ownership: "EXTERNAL" });
      const ref = await f.services.items.addReference(f.bob, {
        itemId: external.id,
        planId: f.planB.id,
      });
      const order = async () => {
        const v = await f.services.plans.getView(f.bob, f.planB.id);
        return [
          ...v.items.filter((t) => t.parentId === null).map((t) => ({ n: t.name, o: t.sortOrder })),
          ...v.references.map((r) => ({ n: r.item.name, o: r.sortOrder })),
        ]
          .sort((x, y) => x.o - y.o)
          .map((x) => x.n);
      };
      expect(await order()).toEqual(["A", "Shared"]);
      await f.services.items.reorderReference(f.bob, ref.id, {
        version: ref.version,
        direction: "up",
      });
      expect(await order()).toEqual(["Shared", "A"]);
      const milestone = await f.task("Gate", { planId: f.planB.id, duration: 0 });
      const current = (await f.services.plans.getView(f.bob, f.planB.id)).references[0]!;
      await expect(
        f.services.items.moveReference(f.bob, ref.id, {
          version: current.version,
          parentId: milestone.id,
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
      expect(a.id).toBeTruthy();
    });

    it("updates plans using an activity when its subtasks move", async () => {
      const phase = await f.task("Phase", { ownership: "EXTERNAL" });
      const step = await f.task("Step", { parentId: phase.id, duration: 2 });
      await f.services.items.addReference(f.bob, { itemId: phase.id, planId: f.planB.id });
      const view = await f.services.plans.getView(f.bob, f.planB.id);
      expect(view.references[0]?.itemKind).toBe("activity");

      const events: { planIds: string[]; entityId: string }[] = [];
      const off = f.services.events.subscribe((e) => events.push(e));
      await f.services.items.move(f.alice, step.id, {
        version: step.version,
        start: "2026-02-02T00:00:00.000Z",
      });
      off();
      // The moved subtask's event reaches the plan using its activity.
      expect(events.find((e) => e.entityId === step.id)?.planIds).toContain(f.planB.id);
      const after = await f.services.plans.getView(f.bob, f.planB.id);
      expect(after.references[0]?.item.start).toBe("2026-02-02T00:00:00.000Z");
    });

    it("refuses local changes to a monitored task", async () => {
      const { ref } = await placedReference();
      await expect(
        f.services.changeRequests.proposeTaskChange(f.bob, ref.id, {
          duration: 9,
          description: "",
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("sends a local change on an AGREEMENT reference to the owner for approval", async () => {
      const { external, phase, ref } = await placedReference();
      await f.services.links.setReferenceType(f.admin, ref.id, { type: "AGREEMENT" });
      const { changeRequest, approvals } = await f.services.changeRequests.proposeTaskChange(
        f.bob,
        ref.id,
        { name: "Interface delivery v2", duration: 8, description: "Needs more time" },
      );
      expect(changeRequest).toMatchObject({ kind: "PROPOSE_TASK_CHANGE", planId: f.planB.id });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ planId: f.planA.id, roles: ["PLAN_OWNER"] });
      // The task dialogs list it; only the owner side can decide.
      const forOwner = await f.services.changeRequests.pendingForItem(f.alice, external.id);
      expect(forOwner).toEqual([
        expect.objectContaining({
          changeRequest: expect.objectContaining({ id: changeRequest.id }),
          decidableApprovalIds: [approvals[0]!.id],
          planName: f.planB.name,
        }),
      ]);
      const forRecipient = await f.services.changeRequests.pendingForItem(f.bob, external.id);
      expect(forRecipient[0]?.decidableApprovalIds).toEqual([]);
      // Nothing changes until the owner approves; both plans see the proposal.
      expect((await f.services.items.get(f.alice, external.id)).duration).toBe(5);
      for (const [ctx, planId] of [
        [f.alice, f.planA.id],
        [f.bob, f.planB.id],
      ] as const) {
        const { proposedChanges } = await f.services.plans.getView(ctx, planId);
        expect(proposedChanges).toEqual([
          expect.objectContaining({
            changeRequestId: changeRequest.id,
            planId: f.planB.id,
            proposed: expect.objectContaining({ itemId: external.id, duration: 8 }),
          }),
        ]);
      }
      await expect(
        f.services.changeRequests.decide(f.bob, approvals[0]!.id, {
          decision: "APPROVE",
          comment: "",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await f.services.changeRequests.decide(f.alice, approvals[0]!.id, {
        decision: "APPROVE",
        comment: "ok",
      });
      const changed = await f.services.items.get(f.alice, external.id);
      expect(changed).toMatchObject({ name: "Interface delivery v2", duration: 8 });
      expect((await f.services.plans.getView(f.bob, f.planB.id)).proposedChanges).toEqual([]);
      expect((await f.services.items.get(f.bob, phase.id)).end).toBe(changed.end);
    });

    it("leaves the task unchanged when the owner rejects or changes it first", async () => {
      const { external, ref } = await placedReference();
      await f.services.links.setReferenceType(f.admin, ref.id, { type: "AGREEMENT" });
      const first = await f.services.changeRequests.proposeTaskChange(f.bob, ref.id, {
        duration: 8,
        description: "",
      });
      await f.services.changeRequests.decide(f.alice, first.approvals[0]!.id, {
        decision: "REJECT",
        comment: "no",
      });
      expect((await f.services.items.get(f.alice, external.id)).duration).toBe(5);

      const second = await f.services.changeRequests.proposeTaskChange(f.bob, ref.id, {
        duration: 9,
        description: "",
      });
      await f.services.items.update(f.alice, external.id, {
        version: (await f.services.items.get(f.alice, external.id)).version,
        name: "Renamed by owner",
      });
      expect(
        (await f.services.changeRequests.get(f.bob, second.changeRequest.id)).changeRequest.status,
      ).toBe("SUPERSEDED");
    });

    describe("schedule changes by the owner of a task used under AGREEMENT", () => {
      async function agreedUse() {
        const placed = await placedReference();
        await f.services.links.setReferenceType(f.admin, placed.ref.id, { type: "AGREEMENT" });
        return placed;
      }
      const current = (id: string) => f.services.items.get(f.alice, id);
      const openProposal = async (planId: string) =>
        (await f.services.plans.getView(planId === f.planB.id ? f.bob : f.alice, planId))
          .proposedChanges[0];
      const NEXT_WEEK = "2026-06-15T00:00:00.000Z";

      it("turns a move into a proposal that applies once the using plan approves", async () => {
        const { external } = await agreedUse();
        const before = await current(external.id);
        const returned = await f.services.items.move(f.alice, external.id, {
          version: before.version,
          start: NEXT_WEEK,
        });
        expect(returned.start).toBe(before.start);
        expect(returned.version).toBe(before.version);
        const proposal = (await openProposal(f.planA.id))!;
        expect(proposal).toMatchObject({
          planId: f.planA.id,
          proposed: { start: NEXT_WEEK, duration: before.duration },
        });
        expect(await openProposal(f.planB.id)).toEqual(proposal);

        const [request] = await f.services.changeRequests.pendingForItem(f.bob, external.id);
        expect(request?.approvals.map((a) => a.planId)).toEqual([f.planB.id]);
        // The owner cannot approve its own change; the using plan decides.
        await expect(
          f.services.changeRequests.decide(f.alice, request!.approvals[0]!.id, {
            decision: "APPROVE",
            comment: "",
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await f.services.changeRequests.decide(f.bob, request!.approvals[0]!.id, {
          decision: "APPROVE",
          comment: "Fine by us",
        });
        expect((await current(external.id)).start).toBe(NEXT_WEEK);
        expect(await openProposal(f.planA.id)).toBeUndefined();
      });

      it("leaves the task as it was when the using plan rejects", async () => {
        const { external } = await agreedUse();
        const before = await current(external.id);
        await f.services.items.update(f.alice, external.id, {
          version: before.version,
          duration: before.duration + 3,
          reason: "Supplier delay",
        });
        expect((await current(external.id)).duration).toBe(before.duration);
        const [request] = await f.services.changeRequests.pendingForItem(f.bob, external.id);
        expect(request?.changeRequest.description).toBe("Supplier delay");
        await f.services.changeRequests.decide(f.bob, request!.approvals[0]!.id, {
          decision: "REJECT",
          comment: "No",
        });
        expect((await current(external.id)).duration).toBe(before.duration);
      });

      it("applies other fields at once, and only proposes the schedule", async () => {
        const { external } = await agreedUse();
        const before = await current(external.id);
        const saved = await f.services.items.update(f.alice, external.id, {
          version: before.version,
          notes: "Changed",
          duration: before.duration + 1,
        });
        expect(saved).toMatchObject({ notes: "Changed", duration: before.duration });
        expect(await openProposal(f.planA.id)).toBeDefined();
      });

      it("does nothing when the dialog saves unchanged values", async () => {
        const { external } = await agreedUse();
        const before = await current(external.id);
        await f.services.items.update(f.alice, external.id, {
          version: before.version,
          start: before.start,
          duration: before.duration,
          granularity: before.granularity,
          name: before.name,
          notes: before.notes,
          ownership: before.ownership,
        });
        expect((await current(external.id)).version).toBe(before.version);
        expect(await openProposal(f.planA.id)).toBeUndefined();
      });

      it("replaces the owner's earlier proposal with a newer one", async () => {
        const { external } = await agreedUse();
        const { version } = await current(external.id);
        await f.services.items.move(f.alice, external.id, { version, start: NEXT_WEEK });
        await f.services.items.move(f.alice, external.id, {
          version,
          start: "2026-06-22T00:00:00.000Z",
        });
        const { proposedChanges } = await f.services.plans.getView(f.alice, f.planA.id);
        expect(proposedChanges.map((c) => c.proposed.start)).toEqual(["2026-06-22T00:00:00.000Z"]);
      });

      it("moves a task only monitored by other plans at once", async () => {
        const { external } = await placedReference();
        const { version } = await current(external.id);
        await f.services.items.move(f.alice, external.id, { version, start: NEXT_WEEK });
        expect((await current(external.id)).start).toBe(NEXT_WEEK);
      });

      it("drops the proposal when the using plan stops using it under AGREEMENT", async () => {
        const { external, ref } = await agreedUse();
        const { version } = await current(external.id);
        await f.services.items.move(f.alice, external.id, { version, start: NEXT_WEEK });
        await f.services.links.setReferenceType(f.admin, ref.id, { type: "MONITOR" });
        expect(await openProposal(f.planA.id)).toBeUndefined();

        await f.services.links.setReferenceType(f.admin, ref.id, { type: "AGREEMENT" });
        await f.services.items.move(f.alice, external.id, { version, start: NEXT_WEEK });
        expect(await openProposal(f.planA.id)).toBeDefined();
        await f.services.items.removeReference(f.bob, ref.id);
        expect(await openProposal(f.planA.id)).toBeUndefined();
      });

      it("refuses to move an activity whose tasks need approval", async () => {
        const { external } = await agreedUse();
        const parent = await f.task("Parent");
        await f.services.items.move(f.alice, external.id, {
          version: (await current(external.id)).version,
          parentId: parent.id,
        });
        const activity = await current(parent.id);
        await expect(
          f.services.items.move(f.alice, parent.id, {
            version: activity.version,
            start: NEXT_WEEK,
          }),
        ).rejects.toBeInstanceOf(RuleViolationError);
      });
    });
  });

  describe("task history", () => {
    it("lists changes, requests, approvals with comments and uses of the task", async () => {
      const task = await f.task("Interface", { ownership: "EXTERNAL" });
      const other = await f.task("Unrelated");
      const ref = await f.services.items.addReference(f.bob, {
        itemId: task.id,
        planId: f.planB.id,
        linkType: "AGREEMENT",
      });
      await f.services.items.update(f.alice, other.id, { version: other.version, notes: "x" });
      const { version } = await f.services.items.get(f.alice, task.id);
      await f.services.items.move(f.alice, task.id, {
        version,
        start: "2026-06-15T00:00:00.000Z",
      });
      const [request] = await f.services.changeRequests.pendingForItem(f.bob, task.id);
      await f.services.changeRequests.decide(f.bob, request!.approvals[0]!.id, {
        decision: "APPROVE",
        comment: "Fine by us",
      });

      const history = await f.services.audit.taskHistory(f.alice, task.id);
      expect(history.entries.map((e) => `${e.entityType}:${e.action}`)).toEqual([
        "task:create",
        "planLink:create",
        "planItemReference:create",
        "changeRequest:create",
        "approval:approve",
        "task:update",
        "changeRequest:accept",
      ]);
      expect(history.entries.some((e) => e.entityId === other.id)).toBe(false);
      expect(history.entries.find((e) => e.action === "approve")?.details.comment).toBe(
        "Fine by us",
      );
      const crId = request!.changeRequest.id;
      expect(history.requests[crId]).toMatchObject({
        planName: f.planA.name,
        proposed: { start: "2026-06-15T00:00:00.000Z" },
      });
      expect(history.planNames[request!.approvals[0]!.id]).toBe(f.planB.name);
      expect(history.planNames[ref.id]).toBe(f.planB.name);
    });

    it("needs access to a project using the task", async () => {
      const task = await f.task("Private");
      await expect(f.services.audit.taskHistory(f.outsider, task.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe("references across the project tree", () => {
    /** A subproject of Apollo with one plan owned by carol (a viewer of Apollo). */
    async function subproject() {
      const project = await f.services.projects.create(f.admin, {
        name: "Apollo sub",
        projectType: "",
        description: "",
        parentProjectId: f.project.id,
      });
      const plan = await f.services.plans.create(f.admin, project.id, {
        name: "Sub plan",
        planType: "internal",
        description: "",
        ownerPartyId: null,
      });
      await f.services.projects.assignRole(f.admin, project.id, {
        userId: f.carol.user.id,
        planId: plan.id,
        role: "PLAN_OWNER",
      });
      return { project, plan };
    }

    it("uses a parent project's task in a subproject plan", async () => {
      const sub = await subproject();
      const task = await f.task("Interface", { ownership: "EXTERNAL" });
      const targets = await f.services.items.referenceTargets(f.admin, task.id);
      expect(targets.map((t) => t.planId)).toEqual(
        expect.arrayContaining([f.planB.id, sub.plan.id]),
      );
      expect(targets.map((t) => t.planId)).not.toContain(f.planA.id);

      const ref = await f.services.items.addReference(f.carol, {
        itemId: task.id,
        planId: sub.plan.id,
      });
      expect(ref.projectId).toBe(sub.project.id);
      const subView = await f.services.plans.getView(f.carol, sub.plan.id);
      expect(subView.references.map((r) => r.item.name)).toEqual(["Interface"]);
      expect(subView.references[0]?.ownerPlanName).toBe(f.planA.name);
      const ownerView = await f.services.plans.getView(f.alice, f.planA.id);
      expect(ownerView.recipients[task.id]).toEqual([
        expect.objectContaining({
          planId: sub.plan.id,
          projectName: "Apollo sub",
          linkType: "MONITOR",
        }),
      ]);
      expect(
        (await f.services.items.referenceTargets(f.admin, task.id)).map((t) => t.planId),
      ).not.toContain(sub.plan.id);
    });

    it("gives external tasks local IDs and links them with local tasks", async () => {
      const sub = await subproject();
      const local = await f.services.items.create(f.carol, {
        planId: sub.plan.id,
        parentId: null,
        name: "Install",
        start: MONDAY,
        duration: 2,
        granularity: "days",
        notes: "",
        ownership: "INTERNAL",
      });
      const delivery = await f.task("Delivery", { ownership: "EXTERNAL" });
      const ref = await f.services.items.addReference(f.carol, {
        itemId: delivery.id,
        planId: sub.plan.id,
      });
      // One sequence of local IDs for own and external tasks.
      expect([local.taskNumber, ref.taskNumber]).toEqual([1, 2]);
      const next = await f.services.items.create(f.carol, {
        planId: sub.plan.id,
        parentId: null,
        name: "Test",
        start: MONDAY,
        duration: 1,
        granularity: "days",
        notes: "",
        ownership: "INTERNAL",
      });
      expect(next.taskNumber).toBe(3);

      // Install waits for the external delivery (cross-project), Test follows Install.
      const [dep] = await f.services.items.setPredecessors(f.carol, local.id, {
        predecessors: "2FS+1d",
      });
      expect(dep).toMatchObject({
        fromItemId: delivery.id,
        projectId: sub.project.id,
        planId: sub.plan.id,
        lag: 1,
      });
      // Predecessors of the external task itself, in the plan using it.
      await expect(
        f.services.items.setPredecessors(f.carol, delivery.id, {
          predecessors: "1",
          planId: sub.plan.id,
        }),
      ).rejects.toBeInstanceOf(RuleViolationError); // would close a loop
      await f.services.items.createDependency(f.carol, {
        fromItemId: local.id,
        toItemId: next.id,
        type: "FS",
        lag: 0,
        planId: sub.plan.id,
      });

      const subView = await f.services.plans.getView(f.carol, sub.plan.id);
      expect(subView.references[0]?.taskNumber).toBe(2);
      expect(subView.dependencies).toHaveLength(2);
      // The owner plan does not see the subproject's own links.
      expect((await f.services.plans.getView(f.alice, f.planA.id)).dependencies).toEqual([]);

      // A task not shown in the plan cannot be linked there.
      const hidden = await f.task("Elsewhere");
      await expect(
        f.services.items.createDependency(f.carol, {
          fromItemId: hidden.id,
          toItemId: local.id,
          type: "FS",
          lag: 0,
          planId: sub.plan.id,
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);

      // Removing the external task removes the plan's links to it.
      await f.services.items.removeReference(f.carol, ref.id);
      const after = await f.services.plans.getView(f.carol, sub.plan.id);
      expect(after.dependencies.map((d) => d.fromItemId)).toEqual([local.id]);
    });

    it("refuses plans outside the project tree", async () => {
      const other = await f.services.projects.create(f.admin, {
        name: "Other",
        projectType: "",
        description: "",
        parentProjectId: null,
      });
      const plan = await f.services.plans.create(f.admin, other.id, {
        name: "Elsewhere",
        planType: "internal",
        description: "",
        ownerPartyId: null,
      });
      const task = await f.task("Interface", { ownership: "EXTERNAL" });
      await expect(
        f.services.items.addReference(f.admin, { itemId: task.id, planId: plan.id }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("chooses MONITOR or AGREEMENT per reference and upgrades it", async () => {
      const sub = await subproject();
      const monitored = await f.task("Monitored", { ownership: "EXTERNAL" });
      const agreed = await f.task("Agreed", { ownership: "EXTERNAL" });
      const ref = await f.services.items.addReference(f.admin, {
        itemId: monitored.id,
        planId: sub.plan.id,
        linkType: "MONITOR",
      });
      await f.services.items.addReference(f.admin, {
        itemId: agreed.id,
        planId: sub.plan.id,
        linkType: "AGREEMENT",
      });
      const types = async () =>
        Object.fromEntries(
          (await f.services.plans.getView(f.carol, sub.plan.id)).references.map((r) => [
            r.item.name,
            r.linkType,
          ]),
        );
      expect(await types()).toEqual({ Monitored: "MONITOR", Agreed: "AGREEMENT" });
      // Only managers of the owner or the receiving plan can set the type.
      await expect(
        f.services.links.setReferenceType(f.bob, ref.id, { type: "AGREEMENT" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // The receiving plan's owner (carol) may upgrade from its side.
      await f.services.links.setReferenceType(f.carol, ref.id, { type: "AGREEMENT" });
      expect((await types()).Monitored).toBe("AGREEMENT");
      await f.services.links.setReferenceType(f.carol, ref.id, { type: "MONITOR" });
      await f.services.links.setReferenceType(f.alice, ref.id, { type: "AGREEMENT" });
      expect(await types()).toEqual({ Monitored: "AGREEMENT", Agreed: "AGREEMENT" });
      // And back: a downgrade to MONITOR.
      await f.services.links.setReferenceType(f.alice, ref.id, { type: "MONITOR" });
      expect(await types()).toEqual({ Monitored: "MONITOR", Agreed: "AGREEMENT" });
    });

    it("asks the subproject plan to approve agreements, in its own project", async () => {
      const sub = await subproject();
      const task = await f.task("Interface", { ownership: "EXTERNAL" });
      await f.services.items.addReference(f.carol, { itemId: task.id, planId: sub.plan.id });
      await acceptToCurrent(f.planA.id, [task.id]);
      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [task.id],
        sourceBaselineId: null,
        title: "Agree interface",
        description: "",
      });
      const forSub = approvals.find((a) => a.planId === sub.plan.id)!;
      expect(forSub.projectId).toBe(sub.project.id);
      const inbox = await f.services.changeRequests.listPending(f.carol);
      expect(inbox.map((p) => p.approval.id)).toContain(forSub.id);
      // The parent's workspace inbox includes subproject approvals on request.
      const ids = async (subprojects: boolean) =>
        (await f.services.changeRequests.listPending(f.admin, f.project.id, subprojects)).map(
          (p) => p.approval.id,
        );
      expect(await ids(true)).toContain(forSub.id);
      expect(await ids(false)).not.toContain(forSub.id);
      for (const a of approvals) {
        const ctx = a.planId === sub.plan.id ? f.carol : f.alice;
        await f.services.changeRequests.decide(ctx, a.id, { decision: "APPROVE", comment: "" });
      }
      const subAgreed = await findTrackBaseline(storage, sub.plan.id, "AGREED");
      expect(subAgreed?.items.map((i) => i.itemId)).toContain(task.id);
    });
  });

  describe("links", () => {
    it("converts stored plan-level links into links per reference, once", async () => {
      const shared = await f.task("Shared", { ownership: "EXTERNAL" });
      const own = await f.task("Own link", { ownership: "EXTERNAL" });
      const r1 = await f.services.items.addReference(f.bob, {
        itemId: shared.id,
        planId: f.planB.id,
      });
      await f.services.items.addReference(f.admin, {
        itemId: own.id,
        planId: f.planB.id,
        linkType: "MONITOR",
      });
      // A plan-level link as stored by earlier versions.
      const now = new Date().toISOString();
      await storage.save("planLink", {
        id: "legacy-link",
        version: 0,
        createdAt: now,
        createdBy: "u",
        updatedAt: now,
        updatedBy: "u",
        projectId: f.project.id,
        type: "AGREEMENT",
        fromPlanId: f.planA.id,
        toPlanId: f.planB.id,
        referenceId: null as unknown as string,
        partyIds: [],
      });
      expect(await f.services.links.convertPlanLevelLinks()).toBe(1);
      expect(await f.services.links.convertPlanLevelLinks()).toBe(0);
      const types = Object.fromEntries(
        (await f.services.plans.getView(f.bob, f.planB.id)).references.map((r) => [
          r.item.name,
          r.linkType,
        ]),
      );
      // The reference without its own link keeps AGREEMENT; one with its own link is unchanged.
      expect(types).toEqual({ Shared: "AGREEMENT", "Own link": "MONITOR" });
      expect(await storage.get("planLink", "legacy-link")).toBeNull();
      expect(r1.id).toBeTruthy();
    });

    it("upgrades MONITOR → AGREEMENT immediately, carrying over agreed values", async () => {
      const item = await f.task("Shared", { ownership: "EXTERNAL" });
      await acceptToCurrent(f.planA.id, [item.id]);
      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "AGREED",
        itemIds: [item.id],
        sourceBaselineId: null,
        title: "Agree",
        description: "",
      });
      for (const a of approvals)
        await f.services.changeRequests.decide(f.alice, a.id, { decision: "APPROVE", comment: "" });
      const ref = await f.services.items.addReference(f.bob, {
        itemId: item.id,
        planId: f.planB.id,
      });
      const link = await f.services.links.setReferenceType(f.admin, ref.id, { type: "MONITOR" });
      expect((await track(f.planB.id, "AGREED"))?.items).toEqual([]);

      const crCountBefore = (await storage.query("changeRequest", { projectId: f.project.id }))
        .length;
      const upgraded = await f.services.links.setReferenceType(f.admin, ref.id, {
        type: "AGREEMENT",
      });
      expect(upgraded).toMatchObject({ id: link.id, type: "AGREEMENT" });
      expect((await storage.query("changeRequest", { projectId: f.project.id })).length).toBe(
        crCountBefore,
      );
      expect((await track(f.planB.id, "AGREED"))?.items[0]).toMatchObject({
        itemId: item.id,
        isReference: true,
      });
      expect((await storage.get("planItemReference", ref.id))?.agreementState).toBe("AGREED");
      const audit = await f.services.audit.list(f.admin, f.project.id, link.id);
      expect(audit.map((a) => a.action)).toContain("upgrade");
    });
  });

  describe("baselines", () => {
    it("never modifies locked baselines", async () => {
      const t = await f.task("T");
      const snapshot = await f.services.baselines.create(f.alice, {
        planId: f.planA.id,
        name: "Q1",
        kind: "SNAPSHOT",
        fromBaselineId: null,
        lock: true,
      });
      expect(snapshot.locked).toBe(true);
      const input = {
        version: snapshot.version,
        start: MONDAY,
        duration: 9,
        granularity: "days" as const,
      };
      await expect(
        f.services.baselines.updateBranchItem(f.alice, snapshot.id, t.id, input),
      ).rejects.toBeInstanceOf(RuleViolationError);
      await expect(
        f.services.baselines.lock(f.alice, snapshot.id, snapshot.version),
      ).rejects.toBeInstanceOf(RuleViolationError);
      await expect(f.services.baselines.delete(f.alice, snapshot.id)).rejects.toBeInstanceOf(
        RuleViolationError,
      );
      expect((await storage.get("baseline", snapshot.id))?.items[0]?.duration).toBe(5);
    });

    it("branches, edits, locks and promotes what-if branches", async () => {
      const t = await f.task("T");
      const snapshot = await f.services.baselines.create(f.alice, {
        planId: f.planA.id,
        name: "Q1",
        kind: "SNAPSHOT",
        fromBaselineId: null,
        lock: true,
      });
      const branch = await f.services.baselines.create(f.alice, {
        planId: f.planA.id,
        name: "What if",
        kind: "BRANCH",
        fromBaselineId: snapshot.id,
        lock: true,
      });
      expect(branch.locked).toBe(false);
      expect(branch.parentBaselineId).toBe(snapshot.id);
      const edited = await f.services.baselines.updateBranchItem(f.alice, branch.id, t.id, {
        version: branch.version,
        start: MONDAY,
        duration: 10,
        granularity: "days",
      });
      expect(edited.items[0]?.duration).toBe(10);
      const tree = await f.services.baselines.tree(f.alice, f.planA.id);
      expect(
        tree.find((n) => n.baseline.id === snapshot.id)?.children.map((c) => c.baseline.id),
      ).toEqual([branch.id]);

      const { approvals } = await f.services.changeRequests.create(f.alice, {
        planId: f.planA.id,
        targetTrack: "ESTIMATED",
        itemIds: [],
        sourceBaselineId: branch.id,
        title: "Promote",
        description: "",
      });
      await f.services.changeRequests.decide(f.alice, approvals[0]!.id, {
        decision: "APPROVE",
        comment: "",
      });
      expect((await f.services.items.get(f.alice, t.id)).duration).toBe(10);

      const locked = await f.services.baselines.lock(f.alice, branch.id, edited.version);
      await expect(
        f.services.baselines.updateBranchItem(f.alice, branch.id, t.id, {
          version: locked.version,
          start: MONDAY,
          duration: 3,
          granularity: "days",
        }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    });

    it("compares the live plan against tracks", async () => {
      const t = await f.task("T");
      await acceptToCurrent(f.planA.id, [t.id]);
      const fresh = await f.services.items.get(f.alice, t.id);
      await f.services.items.update(f.alice, t.id, { version: fresh.version, duration: 7 });
      const cmp = await f.services.baselines.compare(f.alice, {
        planId: f.planA.id,
        against: ["CURRENT", "AGREED"],
      });
      // 5 → 7 working days moves the end from Saturday to Wednesday: +4 calendar days.
      expect(cmp.rows[0]?.endVarianceDays).toEqual({ CURRENT: 4, AGREED: null });
    });
  });

  describe("timelines and reports", () => {
    it("stores timeline entries as references", async () => {
      const t = await f.task("T");
      const tl = await f.services.timelines.create(f.alice, f.project.id, {
        name: "Roadmap",
        start: MONDAY,
        end: "2026-12-31T00:00:00.000Z",
        scale: "months",
        rows: [{ id: "r1", name: "Row" }],
      });
      const updated = await f.services.timelines.update(f.alice, tl.id, {
        version: tl.version,
        entries: [
          { id: "e1", rowId: "r1", itemId: t.id, planId: f.planA.id, placement: "on", line: 0 },
          {
            id: "callout",
            rowId: "r1",
            itemId: t.id,
            planId: f.planA.id,
            placement: "below",
            line: 0,
            calloutX: 12,
            calloutY: 40,
          },
        ],
      });
      const expected = [
        { id: "e1", rowId: "r1", itemId: t.id, planId: f.planA.id, placement: "on", line: 0 },
        {
          id: "callout",
          rowId: "r1",
          itemId: t.id,
          planId: f.planA.id,
          placement: "below",
          line: 0,
          calloutX: 12,
          calloutY: 40,
        },
      ];
      expect(updated.entries).toEqual(expected);
      expect((await f.services.timelines.get(f.alice, tl.id)).entries).toEqual(expected);
      await expect(
        f.services.timelines.update(f.alice, tl.id, {
          version: updated.version,
          entries: [
            { id: "e2", rowId: "nope", itemId: t.id, planId: f.planA.id, placement: "on", line: 0 },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Tasks of any other project can be placed on the timeline, by users who can read them.
      const sub = await f.services.projects.create(f.admin, {
        name: "Sub",
        projectType: "",
        description: "",
        parentProjectId: f.project.id,
      });
      const subPlan = await f.services.plans.create(f.admin, sub.id, {
        name: "Sub plan",
        planType: "internal",
        description: "",
        ownerPartyId: null,
      });
      const foreign = await f.services.items.create(f.admin, {
        planId: subPlan.id,
        parentId: null,
        name: "Foreign",
        start: MONDAY,
        duration: 1,
        granularity: "days",
        notes: "",
        ownership: "INTERNAL",
      });
      const foreignEntry = {
        id: "e3",
        rowId: "r1",
        itemId: foreign.id,
        planId: subPlan.id,
        placement: "on" as const,
        line: 0,
      };
      await expect(
        f.services.timelines.update(f.alice, tl.id, {
          version: updated.version,
          entries: [...updated.entries, foreignEntry],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const withForeign = await f.services.timelines.update(f.admin, tl.id, {
        version: updated.version,
        entries: [...updated.entries, foreignEntry],
      });
      expect(withForeign.entries.map((e) => e.itemId)).toContain(foreign.id);
      // Deleting the other project's plan removes its tasks from this timeline.
      await f.services.items.delete(f.admin, foreign.id, foreign.version);
      await f.services.plans.delete(
        f.admin,
        subPlan.id,
        (await storage.get("plan", subPlan.id))!.version,
      );
      expect((await storage.get("timeline", tl.id))?.entries.map((e) => e.itemId)).not.toContain(
        foreign.id,
      );
    });

    it("generates deterministic reports in all formats", async () => {
      const parent = await f.task("Phase");
      await f.task("Step", { parentId: parent.id });
      await acceptToCurrent(f.planA.id, []);
      const current = (await track(f.planA.id, "CURRENT"))!;
      const def = await f.services.reports.create(f.alice, f.project.id, {
        name: "Status",
        planIds: [f.planA.id],
        timelineIds: [],
        baselineIds: [current.id],
        rangeStart: null,
        rangeEnd: null,
        granularity: "days",
        filter: {},
      });
      const html1 = await f.services.reports.run(f.alice, def.id, {
        format: "html",
        asOfBaselineId: null,
      });
      const html2 = await f.services.reports.run(f.alice, def.id, {
        format: "html",
        asOfBaselineId: null,
      });
      expect(html1.body).toBe(html2.body);
      expect(html1.body).toContain("Phase");
      const csv = await f.services.reports.run(f.alice, def.id, {
        format: "csv",
        asOfBaselineId: null,
      });
      expect(csv.body.split("\r\n")[1]).toContain("Contract,Live data,Phase,0,activity");
      const pdf = await f.services.reports.run(f.alice, def.id, {
        format: "pdf",
        asOfBaselineId: null,
      });
      expect(Buffer.from(pdf.body, "base64").subarray(0, 8).toString()).toBe("%PDF-1.4");
      expect(pdf.body).toBe(
        (await f.services.reports.run(f.alice, def.id, { format: "pdf", asOfBaselineId: null }))
          .body,
      );
      const filtered = await f.services.reports.update(f.alice, def.id, {
        ...def,
        filter: { kinds: ["task"] },
        version: def.version,
      });
      const onlyTasks = await f.services.reports.run(f.alice, filtered.id, {
        format: "csv",
        asOfBaselineId: null,
      });
      expect(onlyTasks.body).not.toContain("Phase");
    });
  });
});
