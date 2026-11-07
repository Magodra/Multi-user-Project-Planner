/** Rules for plan items (CLAUDE.md §4 "Item kinds"). Pure logic, no I/O. */
import {
  type Schedule,
  type Task,
  type WorkingCalendar,
  getItemKind,
  makeSchedule,
  scheduleFromRange,
  spanOf,
} from "@planning/shared";
import { compareTaskOrder } from "./dependencies.js";
import { RuleViolationError } from "./errors.js";

export { getItemKind };

/** A milestone (zero duration) cannot get subtasks. */
export function assertCanAddSubtask(parent: Task, siblings: readonly unknown[]): void {
  if (getItemKind(parent, siblings.length) === "milestone") {
    throw new RuleViolationError(`'${parent.name}' is a milestone and cannot have subtasks`);
  }
}

/** Activity dates are rolled up from subtasks and cannot be edited directly. */
export function assertScheduleEditable(task: Task, subtaskCount: number): void {
  if (getItemKind(task, subtaskCount) === "activity") {
    throw new RuleViolationError(`'${task.name}' is an activity; its dates follow its subtasks`);
  }
}

/** A task cannot become its own ancestor. */
export function assertNoCycle(
  taskId: string,
  newParentId: string | null,
  byId: Map<string, Task>,
): void {
  let cursor = newParentId;
  while (cursor !== null) {
    if (cursor === taskId) throw new RuleViolationError("A task cannot be moved under itself");
    cursor = byId.get(cursor)?.parentId ?? null;
  }
}

export interface ScheduleChange {
  start?: string;
  end?: string;
  duration?: number;
  granularity?: Task["granularity"];
}

/**
 * Apply a schedule change. `duration` wins over `end`; if only `end` is
 * given, the duration is recomputed from the range in the item's unit.
 */
export function applyScheduleChange(
  task: Schedule,
  change: ScheduleChange,
  calendar: WorkingCalendar,
): Schedule {
  const granularity = change.granularity ?? task.granularity;
  const start = change.start ?? task.start;
  if (change.duration !== undefined)
    return makeSchedule(start, change.duration, granularity, calendar);
  if (change.end !== undefined) return scheduleFromRange(start, change.end, granularity, calendar);
  return makeSchedule(start, task.duration, granularity, calendar);
}

/** A referenced task placed under a local task: counts as a subtask with the owner's schedule. */
export interface PlacedSchedule extends Schedule {
  parentId: string;
}

/**
 * Recompute rolled-up schedules for all activities in a plan. Returns only
 * the tasks whose schedule changed. Deepest activities are computed first.
 * `placed` are references to external tasks placed under the plan's tasks.
 */
export function rollUpActivities(
  tasks: Task[],
  calendar: WorkingCalendar,
  placed: PlacedSchedule[] = [],
): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const children = new Map<string, Schedule[]>();
  for (const t of [...byId.values(), ...placed]) {
    if (t.parentId !== null && byId.has(t.parentId)) {
      children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
    }
  }
  const depth = (t: Task): number => {
    let d = 0;
    let p = t.parentId;
    while (p !== null && byId.has(p) && d < tasks.length) {
      d++;
      p = byId.get(p)!.parentId;
    }
    return d;
  };
  const activities = [...children.keys()]
    .map((id) => byId.get(id)!)
    .sort((a, b) => depth(b) - depth(a));
  const changed: Task[] = [];
  for (const activity of activities) {
    const span = spanOf(children.get(activity.id)!, activity.granularity, calendar);
    if (!span) continue;
    if (
      span.start !== activity.start ||
      span.end !== activity.end ||
      span.duration !== activity.duration
    ) {
      Object.assign(activity, span);
      changed.push(activity);
    }
  }
  return changed;
}

/** A row in a plan's hierarchy: an own task, or a reference to another plan's task. */
export interface HierarchyNode {
  id: string;
  parentId: string | null;
  sortOrder: number;
  name: string;
  /** False for a reference: subtasks can only be placed under the plan's own tasks. */
  canHaveSubtasks: boolean;
}

export interface LevelChange {
  parentId: string | null;
  /** New sortOrders, including the moved node's. */
  sortOrders: Map<string, number>;
}

/**
 * Indent: the node becomes the last subtask of the sibling above it.
 * Outdent: the node moves up one level and is placed right after its old
 * parent; the siblings it leaves stay where they are.
 */
export function changeLevel(
  nodes: readonly HierarchyNode[],
  movedId: string,
  direction: "indent" | "outdent",
): LevelChange {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moved = byId.get(movedId);
  if (!moved) throw new RuleViolationError("The task is not in this plan");
  const childrenOf = (parentId: string | null) =>
    nodes.filter((n) => n.parentId === parentId && n.id !== movedId).sort(compareTaskOrder);

  if (direction === "indent") {
    const siblings = nodes.filter((n) => n.parentId === moved.parentId).sort(compareTaskOrder);
    const above = siblings[siblings.indexOf(moved) - 1];
    if (!above)
      throw new RuleViolationError(
        `There is no task above '${moved.name}' to make it a subtask of`,
      );
    if (!above.canHaveSubtasks)
      throw new RuleViolationError(
        `'${above.name}' is a task from another plan and cannot have subtasks here`,
      );
    const last = childrenOf(above.id).reduce((max, n) => Math.max(max, n.sortOrder), -1);
    return { parentId: above.id, sortOrders: new Map([[movedId, last + 1]]) };
  }

  if (moved.parentId === null)
    throw new RuleViolationError(`'${moved.name}' is already at the top level`);
  const parent = byId.get(moved.parentId);
  if (!parent) throw new RuleViolationError("The task's parent is not in this plan");
  const ordered = childrenOf(parent.parentId);
  ordered.splice(ordered.indexOf(parent) + 1, 0, moved);
  const sortOrders = new Map<string, number>();
  ordered.forEach((n, i) => {
    if (n.id === movedId || n.sortOrder !== i) sortOrders.set(n.id, i);
  });
  return { parentId: parent.parentId, sortOrders };
}
