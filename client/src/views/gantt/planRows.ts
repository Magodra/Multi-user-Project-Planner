/**
 * A plan's hierarchy as shown in the Gantt and the task list: local tasks and
 * references to external tasks share one order under each parent.
 */
import type { TaskRecipient } from "../../components/status";
import type { PlanView, ResolvedReference, Task } from "@planning/shared";

type RowBody = { type: "task"; task: Task } | { type: "reference"; reference: ResolvedReference };

export type PlanRow = RowBody & { depth: number };

interface Entry {
  row: RowBody;
  id: string;
  sortOrder: number;
  name: string;
}

/** Depth-first rows; references whose parent is gone are shown at the top level. */
export function planRows(view: PlanView): PlanRow[] {
  const taskIds = new Set(view.items.map((t) => t.id));
  const children = new Map<string | null, Entry[]>();
  const add = (parentId: string | null, entry: Entry) =>
    children.set(parentId, [...(children.get(parentId) ?? []), entry]);
  for (const task of view.items)
    add(task.parentId, {
      row: { type: "task", task },
      id: task.id,
      sortOrder: task.sortOrder,
      name: task.name,
    });
  for (const reference of view.references)
    add(reference.parentId && taskIds.has(reference.parentId) ? reference.parentId : null, {
      row: { type: "reference", reference },
      id: reference.id,
      sortOrder: reference.sortOrder,
      name: reference.item.name,
    });
  const rows: PlanRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const sorted = (children.get(parentId) ?? []).sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    for (const e of sorted) {
      rows.push({ ...e.row, depth });
      if (e.row.type === "task") visit(e.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Siblings (same parent) of a row, in display order. */
export function siblingsOf(rows: PlanRow[], row: PlanRow): PlanRow[] {
  const parentOf = (r: PlanRow) => (r.type === "task" ? r.task.parentId : r.reference.parentId);
  const parent = parentOf(row);
  return rows.filter((r) => r.depth === row.depth && parentOf(r) === parent);
}

/** How an external task is named in a plan using it: "Delivery (from Supplier)". */
export function referenceName(reference: ResolvedReference): string {
  return reference.ownerPlanName
    ? `${reference.item.name} (from ${reference.ownerPlanName})`
    : reference.item.name;
}

/** Names of the plans using an own external task; plans of other projects get their project's name. */
export function taskRecipients(view: PlanView, taskId: string): TaskRecipient[] {
  return (view.recipients[taskId] ?? []).map((r) => ({
    name: r.projectId === view.plan.projectId ? r.planName : `${r.planName} (${r.projectName})`,
    linkType: r.linkType,
  }));
}
