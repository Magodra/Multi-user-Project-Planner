import {
  type AddReferenceInput,
  type ChangeTaskLevelInput,
  type CreateDependencyInput,
  type CreateTaskInput,
  type Dependency,
  type MoveReferenceInput,
  type MoveTaskInput,
  type Plan,
  type PlanItemReference,
  type ReferenceTarget,
  type ReorderTaskInput,
  type SetPredecessorsInput,
  type Task,
  type UpdateTaskInput,
  type WorkingCalendar,
  addCalendarUnits,
  calendarDaysBetween,
  makeSchedule,
  parsePredecessors,
} from "@planning/shared";
import {
  assertNoDependencyCycle,
  assertNotOwnActivity,
  missingTaskNumbers,
  normalizeDependency,
  reorderSiblings,
} from "../domain/dependencies.js";
import { ConflictError, RuleViolationError, ValidationError } from "../domain/errors.js";
import { assertSameProjectTree, rootProjectId } from "../domain/projects.js";
import { normalizeReference } from "../domain/references.js";
import {
  type HierarchyNode,
  type LevelChange,
  applyScheduleChange,
  assertCanAddSubtask,
  assertNoCycle,
  assertScheduleEditable,
  changeLevel,
} from "../domain/items.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import { type ChangeEvent, type EventBus, perProject } from "./events.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";
import {
  childCount,
  rollUpPlan,
  saveTaskChange,
  setReferenceLinkType,
  supersedeOpenRequests,
  taskChangeAudience,
} from "./workflow.js";

/** A task as shown in one plan: own task or external task, with its local ID and parent. */
interface PlanRowInfo {
  id: string;
  number: number;
  parentId: string | null;
  name: string;
  /** The task itself (owned by this plan or by another one). */
  item: Task;
}

export class ItemService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async get(ctx: ServiceContext, itemId: string): Promise<Task> {
    const task = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, task.projectId, task.planId, "plan.read");
    return task;
  }

  async create(ctx: ServiceContext, input: CreateTaskInput): Promise<Task> {
    const plan = await mustGet(this.storage, "plan", input.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.edit");
    const { projectId } = plan;
    const saved = await this.storage.transaction(async (tx) => {
      const project = await mustGet(tx, "project", projectId);
      const planTasks = await tx.query("task", { projectId, planId: plan.id });
      const siblings = planTasks.filter((t) => t.parentId === input.parentId);
      const taskNumber = await this.nextTaskNumber(tx, projectId, plan.id);
      if (input.parentId) {
        const parent = await mustGet(tx, "task", input.parentId);
        if (parent.planId !== plan.id) throw new ValidationError("Parent belongs to another plan");
        assertCanAddSubtask(parent, siblings);
      }
      const task: Task = {
        ...newMeta(ctx),
        projectId,
        planId: plan.id,
        parentId: input.parentId,
        taskNumber,
        name: input.name,
        notes: input.notes,
        sortOrder: await this.nextSortOrder(tx, projectId, plan.id, input.parentId),
        ownership: input.ownership,
        agreementState: "NONE",
        ...makeSchedule(input.start, input.duration, input.granularity, project.calendar),
      };
      await tx.save("task", task);
      await rollUpPlan(tx, projectId, plan.id, project.calendar);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "task",
        entityId: task.id,
        action: "create",
        details: { name: task.name },
      });
      return mustGet(tx, "task", task.id);
    });
    this.events.emit(await this.eventFor(saved, "create"));
    return saved;
  }

  async update(ctx: ServiceContext, itemId: string, input: UpdateTaskInput): Promise<Task> {
    const existing = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const task = await mustGet(tx, "task", itemId);
      if (task.version !== input.version)
        throw new ConflictError("Task was changed by someone else");
      const project = await mustGet(tx, "project", task.projectId);
      const children = await childCount(tx, task);
      const scheduleTouched = [input.start, input.end, input.duration, input.granularity].some(
        (v) => v !== undefined,
      );
      if (scheduleTouched) assertScheduleEditable(task, children);
      if (input.duration === 0 && children > 0) {
        throw new RuleViolationError("An activity cannot become a milestone");
      }
      if (input.ownership === "INTERNAL" && task.ownership === "EXTERNAL") {
        const refs = await tx.query("planItemReference", { itemId });
        if (refs.length > 0)
          throw new RuleViolationError("Task is used in other plans and must stay external");
      }
      const schedule = scheduleTouched ? applyScheduleChange(task, input, project.calendar) : {};
      const updated = touch(task, ctx, {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.ownership !== undefined && { ownership: input.ownership }),
        ...schedule,
      });
      await this.afterChange(tx, ctx, task, updated, project.calendar, "update", input);
      return mustGet(tx, "task", itemId);
    });
    this.events.emit(await this.eventFor(saved, "update"));
    return saved;
  }

  /** Move in time (keeping the duration) and/or in the hierarchy. Moving an activity moves its subtasks. */
  async move(ctx: ServiceContext, itemId: string, input: MoveTaskInput): Promise<Task> {
    const existing = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const task = await mustGet(tx, "task", itemId);
      if (task.version !== input.version)
        throw new ConflictError("Task was changed by someone else");
      const project = await mustGet(tx, "project", task.projectId);
      const planTasks = await tx.query("task", { projectId: task.projectId, planId: task.planId });
      const byId = new Map(planTasks.map((t) => [t.id, t]));
      let updated = touch(task, ctx);
      if (input.parentId !== undefined && input.parentId !== task.parentId) {
        if (input.parentId !== null) {
          const parent = byId.get(input.parentId);
          if (!parent) throw new ValidationError("New parent must be in the same plan");
          assertNoCycle(task.id, input.parentId, byId);
          assertCanAddSubtask(
            parent,
            planTasks.filter((t) => t.parentId === parent.id),
          );
        }
        updated.parentId = input.parentId;
      }
      if (input.sortOrder !== undefined) updated.sortOrder = input.sortOrder;
      if (input.start !== undefined) {
        const descendants = collectDescendants(task.id, planTasks);
        if (descendants.length > 0) {
          // Shift every leaf by the same calendar offset; the activity follows by roll-up.
          const offsetDays = calendarDaysBetween(task.start, input.start);
          for (const d of descendants.filter((x) => !planTasks.some((t) => t.parentId === x.id))) {
            const start = addCalendarUnits(d.start, offsetDays, "days");
            await tx.save(
              "task",
              touch(d, ctx, makeSchedule(start, d.duration, d.granularity, project.calendar)),
            );
          }
        } else {
          updated = {
            ...updated,
            ...makeSchedule(input.start, task.duration, task.granularity, project.calendar),
          };
        }
      }
      await this.afterChange(tx, ctx, task, updated, project.calendar, "move", input);
      return mustGet(tx, "task", itemId);
    });
    this.events.emit(await this.eventFor(saved, "move", existing));
    return saved;
  }

  /** Move a task one place up or down among its siblings. A no-op at either end. */
  async reorder(ctx: ServiceContext, itemId: string, input: ReorderTaskInput): Promise<Task> {
    const existing = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const task = await mustGet(tx, "task", itemId);
      if (task.version !== input.version)
        throw new ConflictError("Task was changed by someone else");
      const changes = await this.reorderAmong(
        tx,
        ctx,
        task.projectId,
        task.planId,
        task.parentId,
        task.id,
        input.direction,
      );
      if (changes.size > 0)
        await this.audit.record(tx, ctx, {
          projectId: task.projectId,
          entityType: "task",
          entityId: task.id,
          action: "reorder",
          details: { direction: input.direction },
        });
      return mustGet(tx, "task", itemId);
    });
    this.events.emit(await this.eventFor(saved, "reorder"));
    return saved;
  }

  async delete(ctx: ServiceContext, itemId: string, version: number): Promise<void> {
    const existing = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const { projectId, planId } = existing;
    const event = await this.eventFor(existing, "delete");
    await this.storage.transaction(async (tx) => {
      const project = await mustGet(tx, "project", projectId);
      if ((await childCount(tx, existing)) > 0) {
        throw new RuleViolationError("Delete or move the subtasks first");
      }
      if ((await tx.query("planItemReference", { itemId })).length > 0) {
        throw new RuleViolationError("Task is used in other plans");
      }
      for (const d of await this.dependenciesOf(tx, itemId))
        await tx.delete("dependency", d.id, d.version);
      await supersedeOpenRequests(tx, ctx, this.audit, projectId, [itemId]);
      await tx.delete("task", itemId, version);
      await rollUpPlan(tx, projectId, planId, project.calendar);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "task",
        entityId: itemId,
        action: "delete",
      });
    });
    this.events.emit(event);
  }

  // --- references ----------------------------------------------------------

  async addReference(ctx: ServiceContext, input: AddReferenceInput): Promise<PlanItemReference> {
    const item = await mustGet(this.storage, "task", input.itemId);
    const plan = await mustGet(this.storage, "plan", input.planId);
    const projects = new Map((await this.storage.query("project")).map((p) => [p.id, p]));
    assertSameProjectTree(plan.projectId, item.projectId, projects);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.edit");
    // External items are shared by design: project membership is enough to use one.
    await this.access.require(ctx, item.projectId, null, "project.read");
    // Choosing AGREEMENT binds both plans: managers of either may do it.
    if (input.linkType === "AGREEMENT")
      await this.access.requireLinkManager(
        ctx,
        { projectId: item.projectId, id: item.planId },
        plan,
      );
    if (item.ownership !== "EXTERNAL")
      throw new RuleViolationError("Only external tasks can be used in other plans");
    if (item.planId === plan.id)
      throw new RuleViolationError("A task cannot reference its own plan");
    const existing = await this.storage.query("planItemReference", {
      planId: plan.id,
      itemId: item.id,
    });
    if (existing[0]) return existing[0];
    const ref: PlanItemReference = {
      ...newMeta(ctx),
      projectId: plan.projectId,
      planId: plan.id,
      itemId: item.id,
      ownerPlanId: item.planId,
      taskNumber: 0,
      parentId: null,
      sortOrder: 0,
      agreementState: "NONE",
    };
    const saved = await this.storage.transaction(async (tx) => {
      ref.sortOrder = await this.nextSortOrder(tx, plan.projectId, plan.id, null);
      ref.taskNumber = await this.nextTaskNumber(tx, plan.projectId, plan.id);
      const r = await tx.save("planItemReference", ref);
      if (input.linkType) await setReferenceLinkType(tx, ctx, this.audit, r, input.linkType);
      await this.audit.record(tx, ctx, {
        projectId: plan.projectId,
        entityType: "planItemReference",
        entityId: ref.id,
        action: "create",
        details: { itemId: item.id, planId: plan.id, linkType: input.linkType ?? null },
      });
      return r;
    });
    this.events.emit(
      perProject([plan.projectId, item.projectId], {
        entityType: "planItemReference",
        entityId: ref.id,
        action: "create",
        planIds: [plan.id, item.planId],
      }),
    );
    return saved;
  }

  /** Plans an external task can be used in: same project tree, edit rights, not yet using it. */
  async referenceTargets(ctx: ServiceContext, itemId: string): Promise<ReferenceTarget[]> {
    const item = await this.get(ctx, itemId);
    const projects = await this.storage.query("project");
    const byId = new Map(projects.map((p) => [p.id, p]));
    const root = rootProjectId(item.projectId, byId);
    const used = new Set(
      (await this.storage.query("planItemReference", { itemId })).map((r) => r.planId),
    );
    const targets: ReferenceTarget[] = [];
    for (const project of projects.filter((p) => rootProjectId(p.id, byId) === root)) {
      for (const plan of await this.storage.query("plan", { projectId: project.id })) {
        if (plan.id === item.planId || used.has(plan.id)) continue;
        if (!(await this.access.canDo(ctx, project.id, plan.id, "plan.edit"))) continue;
        targets.push({
          planId: plan.id,
          planName: plan.name,
          projectId: project.id,
          projectName: project.name,
        });
      }
    }
    return targets.sort(
      (a, b) =>
        Number(b.projectId === item.projectId) - Number(a.projectId === item.projectId) ||
        a.projectName.localeCompare(b.projectName) ||
        a.planName.localeCompare(b.planName),
    );
  }

  async removeReference(ctx: ServiceContext, referenceId: string): Promise<void> {
    const ref = await mustGet(this.storage, "planItemReference", referenceId);
    await this.access.require(ctx, ref.projectId, ref.planId, "plan.edit");
    await this.storage.transaction(async (tx) => {
      for (const link of await tx.query("planLink", { projectId: ref.projectId, referenceId })) {
        await tx.delete("planLink", link.id, link.version);
      }
      // The plan's dependencies on the task go with it.
      for (const d of await this.dependenciesOf(tx, ref.itemId)) {
        const planId = d.planId ?? (await tx.get("task", d.toItemId))?.planId;
        if (planId === ref.planId) await tx.delete("dependency", d.id, d.version);
      }
      await tx.delete("planItemReference", ref.id, ref.version);
      const project = await mustGet(tx, "project", ref.projectId);
      await rollUpPlan(tx, ref.projectId, ref.planId, project.calendar);
      await this.audit.record(tx, ctx, {
        projectId: ref.projectId,
        entityType: "planItemReference",
        entityId: ref.id,
        action: "delete",
      });
    });
    const owner = await this.storage.get("plan", ref.ownerPlanId);
    this.events.emit(
      perProject([ref.projectId, owner?.projectId ?? ref.projectId], {
        entityType: "planItemReference",
        entityId: ref.id,
        action: "delete",
        planIds: [ref.planId, ref.ownerPlanId],
      }),
    );
  }

  /** Place a reference under a local task of its plan (or at the top level). */
  async moveReference(
    ctx: ServiceContext,
    referenceId: string,
    input: MoveReferenceInput,
  ): Promise<PlanItemReference> {
    const existing = await mustGet(this.storage, "planItemReference", referenceId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const { projectId, planId } = existing;
    const saved = await this.storage.transaction(async (tx) => {
      const ref = normalizeReference(await mustGet(tx, "planItemReference", referenceId));
      if (ref.version !== input.version)
        throw new ConflictError("Reference was changed by someone else");
      if (input.parentId !== null) {
        const parent = await tx.get("task", input.parentId);
        if (!parent || parent.planId !== planId)
          throw new ValidationError("The parent must be a task of this plan");
        assertCanAddSubtask(parent, new Array<unknown>(await childCount(tx, parent)));
      }
      const updated = await tx.save(
        "planItemReference",
        touch(ref, ctx, {
          parentId: input.parentId,
          sortOrder:
            input.parentId === ref.parentId
              ? ref.sortOrder
              : await this.nextSortOrder(tx, projectId, planId, input.parentId),
        }),
      );
      const project = await mustGet(tx, "project", projectId);
      await rollUpPlan(tx, projectId, planId, project.calendar);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "planItemReference",
        entityId: ref.id,
        action: "move",
        details: { parentId: input.parentId },
      });
      return updated;
    });
    this.emitReference(saved, "move");
    return saved;
  }

  /** Move a reference one place up or down among its siblings (tasks and references). */
  async reorderReference(
    ctx: ServiceContext,
    referenceId: string,
    input: ReorderTaskInput,
  ): Promise<PlanItemReference> {
    const existing = await mustGet(this.storage, "planItemReference", referenceId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const ref = normalizeReference(await mustGet(tx, "planItemReference", referenceId));
      if (ref.version !== input.version)
        throw new ConflictError("Reference was changed by someone else");
      const changes = await this.reorderAmong(
        tx,
        ctx,
        ref.projectId,
        ref.planId,
        ref.parentId,
        ref.id,
        input.direction,
      );
      if (changes.size > 0)
        await this.audit.record(tx, ctx, {
          projectId: ref.projectId,
          entityType: "planItemReference",
          entityId: ref.id,
          action: "reorder",
          details: { direction: input.direction },
        });
      return normalizeReference(await mustGet(tx, "planItemReference", referenceId));
    });
    this.emitReference(saved, "reorder");
    return saved;
  }

  /**
   * Indent a task (make it a subtask of the task above it) or outdent it (one
   * level up, right after its parent). Like a move in the hierarchy, it
   * changes the activities' rolled-up dates.
   */
  async changeLevel(
    ctx: ServiceContext,
    itemId: string,
    input: ChangeTaskLevelInput,
  ): Promise<Task> {
    const existing = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const task = await mustGet(tx, "task", itemId);
      if (task.version !== input.version)
        throw new ConflictError("Task was changed by someone else");
      const change = await this.applyLevelChange(
        tx,
        ctx,
        task.projectId,
        task.planId,
        task.id,
        task.id,
        input.direction,
      );
      const project = await mustGet(tx, "project", task.projectId);
      const updated = touch(task, ctx, {
        parentId: change.parentId,
        sortOrder: change.sortOrders.get(task.id)!,
      });
      await this.afterChange(tx, ctx, task, updated, project.calendar, input.direction, {
        parentId: change.parentId,
      });
      return mustGet(tx, "task", itemId);
    });
    this.events.emit(await this.eventFor(saved, input.direction, existing));
    return saved;
  }

  /** Indent or outdent an external task among the local tasks of the plan using it. */
  async changeReferenceLevel(
    ctx: ServiceContext,
    referenceId: string,
    input: ChangeTaskLevelInput,
  ): Promise<PlanItemReference> {
    const existing = await mustGet(this.storage, "planItemReference", referenceId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const ref = normalizeReference(await mustGet(tx, "planItemReference", referenceId));
      if (ref.version !== input.version)
        throw new ConflictError("Reference was changed by someone else");
      const change = await this.applyLevelChange(
        tx,
        ctx,
        ref.projectId,
        ref.planId,
        ref.id,
        ref.itemId,
        input.direction,
      );
      const updated = await tx.save(
        "planItemReference",
        touch(ref, ctx, { parentId: change.parentId, sortOrder: change.sortOrders.get(ref.id)! }),
      );
      const project = await mustGet(tx, "project", ref.projectId);
      await rollUpPlan(tx, ref.projectId, ref.planId, project.calendar);
      await this.audit.record(tx, ctx, {
        projectId: ref.projectId,
        entityType: "planItemReference",
        entityId: ref.id,
        action: input.direction,
        details: { parentId: change.parentId },
      });
      return updated;
    });
    this.emitReference(saved, input.direction);
    return saved;
  }

  // --- dependencies --------------------------------------------------------

  /**
   * Link two tasks shown in one plan (own tasks or external tasks used in
   * it, also from other projects of the tree). The dependency belongs to that
   * plan and is stored in its project.
   */
  async createDependency(ctx: ServiceContext, input: CreateDependencyInput): Promise<Dependency> {
    if (input.fromItemId === input.toItemId)
      throw new RuleViolationError("A task cannot depend on itself");
    const to = await mustGet(this.storage, "task", input.toItemId);
    const plan = await mustGet(this.storage, "plan", input.planId ?? to.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const rows = await this.planRows(tx, plan);
      const from = rows.get(input.fromItemId);
      const successor = rows.get(input.toItemId);
      if (!from || !successor)
        throw new RuleViolationError("Both tasks must be shown in this plan to be linked");
      const all = await this.dependenciesAround(tx, plan, rows);
      if (
        all.some(
          (d) => d.fromItemId === from.id && d.toItemId === successor.id && d.type === input.type,
        )
      )
        throw new ConflictError("Dependency already exists");
      assertNotOwnActivity(from, successor, rows);
      assertNoDependencyCycle(from.id, successor.id, all);
      const dep: Dependency = {
        ...newMeta(ctx),
        projectId: plan.projectId,
        planId: plan.id,
        fromItemId: from.id,
        toItemId: successor.id,
        type: input.type,
        lag: input.lag,
        lagUnit: input.lagUnit ?? successor.item.granularity,
      };
      const d = await tx.save("dependency", dep);
      await this.audit.record(tx, ctx, {
        projectId: plan.projectId,
        entityType: "dependency",
        entityId: dep.id,
        action: "create",
        details: { ...input, planId: plan.id },
      });
      return d;
    });
    this.emitDependency(plan, saved.id, "create");
    return saved;
  }

  /**
   * Replace a task's predecessors in a plan from notation such as "4FS+3d; 2SS",
   * using that plan's local task IDs (its own tasks and external tasks used in
   * it). `planId` defaults to the task's own plan; for an external task it is
   * the plan using it. Only the plan's own dependencies are replaced. Returns
   * the task's predecessors in the plan after the change.
   */
  async setPredecessors(
    ctx: ServiceContext,
    itemId: string,
    input: SetPredecessorsInput,
  ): Promise<Dependency[]> {
    const parsed = parsePredecessors(input.predecessors);
    if (!parsed.ok) throw new ValidationError(parsed.error);
    const existing = await mustGet(this.storage, "task", itemId);
    const plan = await mustGet(this.storage, "plan", input.planId ?? existing.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.edit");
    const result = await this.storage.transaction(async (tx) => {
      const rows = await this.planRows(tx, plan);
      const task = rows.get(itemId);
      if (!task) throw new ValidationError("The task is not shown in this plan");
      const byNumber = new Map([...rows.values()].map((r) => [r.number, r]));
      const allDeps = await this.dependenciesAround(tx, plan, rows);
      const key = (fromItemId: string, type: string) => `${fromItemId}|${type}`;
      // The task's predecessors that belong to this plan: the set this call replaces.
      const replaced = allDeps.filter((d) => d.toItemId === task.id && d.planId === plan.id);
      const current = new Map(replaced.map((d) => [key(d.fromItemId, d.type), d]));
      const others = allDeps.filter((d) => !replaced.includes(d));
      const wanted = new Map<string, Dependency>();
      for (const spec of parsed.predecessors) {
        const from = byNumber.get(spec.taskNumber);
        if (!from) throw new ValidationError(`There is no task ${spec.taskNumber} in this plan`);
        if (from.id === task.id) throw new RuleViolationError("A task cannot depend on itself");
        assertNotOwnActivity(from, task, rows);
        assertNoDependencyCycle(from.id, task.id, [...others, ...wanted.values()]);
        const k = key(from.id, spec.type);
        const lagUnit = spec.lagUnit ?? task.item.granularity;
        const old = current.get(k);
        wanted.set(
          k,
          old
            ? { ...old, lag: spec.lag, lagUnit }
            : {
                ...newMeta(ctx),
                projectId: plan.projectId,
                planId: plan.id,
                fromItemId: from.id,
                toItemId: task.id,
                type: spec.type,
                lag: spec.lag,
                lagUnit,
              },
        );
      }
      for (const [k, old] of current) {
        if (wanted.has(k)) continue;
        await tx.delete("dependency", old.id, old.version);
        await this.audit.record(tx, ctx, {
          projectId: old.projectId,
          entityType: "dependency",
          entityId: old.id,
          action: "delete",
        });
      }
      const out: Dependency[] = [];
      for (const [k, dep] of wanted) {
        const old = current.get(k);
        if (old && old.lag === dep.lag && old.lagUnit === dep.lagUnit) {
          out.push(old);
          continue;
        }
        out.push(await tx.save("dependency", old ? touch(dep, ctx) : dep));
        await this.audit.record(tx, ctx, {
          projectId: dep.projectId,
          entityType: "dependency",
          entityId: dep.id,
          action: old ? "update" : "create",
          details: {
            fromItemId: dep.fromItemId,
            type: dep.type,
            lag: dep.lag,
            lagUnit: dep.lagUnit,
            planId: plan.id,
          },
        });
      }
      return out;
    });
    this.emitDependency(plan, itemId, "update");
    return result;
  }

  /** Delete a dependency; managed by the editors of the plan it belongs to. */
  async deleteDependency(ctx: ServiceContext, dependencyId: string): Promise<void> {
    const stored = await mustGet(this.storage, "dependency", dependencyId);
    const successor = await mustGet(this.storage, "task", stored.toItemId);
    const dep = normalizeDependency(stored, successor);
    const plan = await mustGet(this.storage, "plan", dep.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.edit");
    await this.storage.transaction(async (tx) => {
      await tx.delete("dependency", dep.id, dep.version);
      await this.audit.record(tx, ctx, {
        projectId: dep.projectId,
        entityType: "dependency",
        entityId: dep.id,
        action: "delete",
      });
    });
    this.emitDependency(plan, dep.id, "delete");
  }

  private emitDependency(plan: Plan, entityId: string, action: string): void {
    this.events.emit({
      projectId: plan.projectId,
      entityType: "dependency",
      entityId,
      action,
      planIds: [plan.id],
    });
  }

  // --- helpers -------------------------------------------------------------

  /** Save a changed item, reset a REJECTED state, supersede open requests and roll up. */
  private async afterChange(
    tx: StorageAdapter,
    ctx: ServiceContext,
    before: Task,
    after: Task,
    calendar: WorkingCalendar,
    action: string,
    details: object,
  ): Promise<void> {
    await saveTaskChange(tx, ctx, this.audit, before, after, calendar, action, details);
  }

  /** Next sortOrder after every task and reference under `parentId` in a plan. */
  private async nextSortOrder(
    tx: StorageAdapter,
    projectId: string,
    planId: string,
    parentId: string | null,
  ): Promise<number> {
    const [tasks, refs] = await Promise.all([
      tx.query("task", { projectId, planId }),
      tx.query("planItemReference", { projectId, planId }),
    ]);
    const siblings = [
      ...tasks.filter((t) => t.parentId === parentId),
      ...refs.map(normalizeReference).filter((r) => r.parentId === parentId),
    ];
    return siblings.reduce((max, s) => Math.max(max, s.sortOrder + 1), 0);
  }

  /**
   * Move a task or reference among its siblings; tasks and references share
   * one order. Order is not part of the schedule: no supersede, no
   * agreement-state change. Returns the changed sortOrders.
   */
  private async reorderAmong(
    tx: StorageAdapter,
    ctx: ServiceContext,
    projectId: string,
    planId: string,
    parentId: string | null,
    movedId: string,
    direction: "up" | "down",
  ): Promise<Map<string, number>> {
    const tasks = (await tx.query("task", { projectId, planId })).filter(
      (t) => t.parentId === parentId,
    );
    const refs = (await tx.query("planItemReference", { projectId, planId }))
      .map(normalizeReference)
      .filter((r) => r.parentId === parentId);
    const names = new Map<string, string>();
    for (const r of refs) names.set(r.id, (await tx.get("task", r.itemId))?.name ?? "");
    const changes = reorderSiblings(
      [
        ...tasks,
        ...refs.map((r) => ({ id: r.id, sortOrder: r.sortOrder, name: names.get(r.id)! })),
      ],
      movedId,
      direction,
    );
    for (const t of tasks) {
      const sortOrder = changes.get(t.id);
      if (sortOrder !== undefined) await tx.save("task", touch(t, ctx, { sortOrder }));
    }
    for (const r of refs) {
      const sortOrder = changes.get(r.id);
      if (sortOrder !== undefined) await tx.save("planItemReference", touch(r, ctx, { sortOrder }));
    }
    return changes;
  }

  /**
   * Works out an indent/outdent in a plan (tasks and references share one
   * hierarchy), checks it and saves the siblings' new sortOrders. The moved
   * task or reference itself is saved by the caller.
   */
  private async applyLevelChange(
    tx: StorageAdapter,
    ctx: ServiceContext,
    projectId: string,
    planId: string,
    movedId: string,
    movedItemId: string,
    direction: "indent" | "outdent",
  ): Promise<LevelChange> {
    const tasks = await tx.query("task", { projectId, planId });
    const refs = (await tx.query("planItemReference", { projectId, planId })).map(
      normalizeReference,
    );
    const taskIds = new Set(tasks.map((t) => t.id));
    const nodes: HierarchyNode[] = tasks.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      sortOrder: t.sortOrder,
      name: t.name,
      canHaveSubtasks: true,
    }));
    for (const r of refs)
      nodes.push({
        id: r.id,
        // A reference under a task that is gone is shown at the top level.
        parentId: r.parentId !== null && taskIds.has(r.parentId) ? r.parentId : null,
        sortOrder: r.sortOrder,
        name: (await tx.get("task", r.itemId))?.name ?? "",
        canHaveSubtasks: false,
      });
    const change = changeLevel(nodes, movedId, direction);
    if (change.parentId !== null) {
      const parent = tasks.find((t) => t.id === change.parentId)!;
      assertCanAddSubtask(parent, new Array<unknown>(await childCount(tx, parent)));
    }
    await this.assertLinksAllowParent(
      tx,
      await mustGet(tx, "plan", planId),
      movedItemId,
      change.parentId,
    );
    for (const t of tasks) {
      const sortOrder = change.sortOrders.get(t.id);
      if (t.id !== movedId && sortOrder !== undefined)
        await tx.save("task", touch(t, ctx, { sortOrder }));
    }
    for (const r of refs) {
      const sortOrder = change.sortOrders.get(r.id);
      if (r.id !== movedId && sortOrder !== undefined)
        await tx.save("planItemReference", touch(r, ctx, { sortOrder }));
    }
    return change;
  }

  /**
   * A task cannot be linked to its own activity or subtasks, so a task linked
   * to the task above it cannot become its subtask (and likewise for outdents
   * that would place it under a task it is linked to).
   */
  private async assertLinksAllowParent(
    tx: StorageAdapter,
    plan: Plan,
    itemId: string,
    parentId: string | null,
  ): Promise<void> {
    const rows = await this.planRows(tx, plan);
    const moved = rows.get(itemId);
    if (!moved) return;
    rows.set(itemId, { ...moved, parentId });
    const subtree = new Set([itemId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows.values())
        if (r.parentId !== null && subtree.has(r.parentId) && !subtree.has(r.id)) {
          subtree.add(r.id);
          grew = true;
        }
    }
    for (const d of await this.dependenciesAround(tx, plan, rows)) {
      const from = rows.get(d.fromItemId);
      const to = rows.get(d.toItemId);
      if (!from || !to || (!subtree.has(from.id) && !subtree.has(to.id))) continue;
      try {
        assertNotOwnActivity(from, to, rows);
      } catch (err) {
        if (!(err instanceof RuleViolationError)) throw err;
        throw new RuleViolationError(
          `'${moved.name}' cannot be placed there: '${from.name}' and '${to.name}' are linked, ` +
            "and a task cannot be linked to its own activity. Remove the dependency first.",
        );
      }
    }
  }

  private emitReference(ref: PlanItemReference, action: string): void {
    this.events.emit({
      projectId: ref.projectId,
      entityType: "planItemReference",
      entityId: ref.id,
      action,
      planIds: [ref.planId],
    });
  }

  /** Dependencies on a task, in any plan and project. */
  private async dependenciesOf(tx: StorageAdapter, itemId: string): Promise<Dependency[]> {
    const [from, to] = await Promise.all([
      tx.query("dependency", { fromItemId: itemId }),
      tx.query("dependency", { toItemId: itemId }),
    ]);
    return [...from, ...to];
  }

  /**
   * Next local task ID of a plan; tasks and references share the sequence.
   * Numbers missing on older tasks and references are stored first.
   */
  private async nextTaskNumber(
    tx: StorageAdapter,
    projectId: string,
    planId: string,
  ): Promise<number> {
    const [tasks, refs] = await Promise.all([
      tx.query("task", { projectId, planId }),
      tx.query("planItemReference", { planId }),
    ]);
    const backfill = missingTaskNumbers([...tasks, ...refs]);
    for (const t of tasks) {
      const taskNumber = backfill.get(t.id);
      if (taskNumber !== undefined) await tx.save("task", { ...t, taskNumber });
    }
    for (const r of refs) {
      const taskNumber = backfill.get(r.id);
      if (taskNumber !== undefined) await tx.save("planItemReference", { ...r, taskNumber });
    }
    const numbers = [...tasks, ...refs].map((x) => backfill.get(x.id) ?? x.taskNumber);
    return Math.max(0, ...numbers) + 1;
  }

  /** Tasks shown in a plan (own and external), keyed by task id, with local IDs and placement. */
  private async planRows(tx: StorageAdapter, plan: Plan): Promise<Map<string, PlanRowInfo>> {
    const [tasks, refs] = await Promise.all([
      tx.query("task", { projectId: plan.projectId, planId: plan.id }),
      tx.query("planItemReference", { planId: plan.id }),
    ]);
    const normalized = refs.map(normalizeReference);
    const backfill = missingTaskNumbers([...tasks, ...normalized]);
    const rows = new Map<string, PlanRowInfo>();
    for (const t of tasks)
      rows.set(t.id, {
        id: t.id,
        number: backfill.get(t.id) ?? t.taskNumber,
        parentId: t.parentId,
        name: t.name,
        item: t,
      });
    for (const r of normalized) {
      const item = await tx.get("task", r.itemId);
      if (item)
        rows.set(item.id, {
          id: item.id,
          number: backfill.get(r.id) ?? r.taskNumber,
          parentId: r.parentId,
          name: item.name,
          item,
        });
    }
    return rows;
  }

  /** Every dependency that can touch a plan's tasks: from its project and the owners' projects. */
  private async dependenciesAround(
    tx: StorageAdapter,
    plan: Plan,
    rows: Map<string, PlanRowInfo>,
  ): Promise<Dependency[]> {
    const projectIds = [
      ...new Set([plan.projectId, ...[...rows.values()].map((r) => r.item.projectId)]),
    ];
    const deps = (
      await Promise.all(projectIds.map((pid) => tx.query("dependency", { projectId: pid })))
    ).flat();
    const out: Dependency[] = [];
    for (const d of deps) {
      const successor = rows.get(d.toItemId)?.item ?? (await tx.get("task", d.toItemId));
      out.push(successor ? normalizeDependency(d, successor) : d);
    }
    return out;
  }

  /**
   * Changes are pushed to every plan using the task or one of its activities
   * (their dates roll up), in any project. `before` adds the activities a
   * moved task left.
   */
  private async eventFor(task: Task, action: string, before?: Task): Promise<ChangeEvent[]> {
    const { projectIds, planIds } = await taskChangeAudience(
      this.storage,
      before ? [task, before] : [task],
    );
    return perProject(projectIds, { entityType: "task", entityId: task.id, action, planIds });
  }
}

function collectDescendants(id: string, tasks: Task[]): Task[] {
  const out: Task[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const t of tasks)
      if (t.parentId === current) {
        out.push(t);
        queue.push(t.id);
      }
  }
  return out;
}
