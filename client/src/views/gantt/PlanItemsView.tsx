/**
 * Outline of a plan: local tasks and external tasks in one hierarchy. Each row
 * can be dragged into a timeline or onto another plan (dnd-kit).
 */
import { useDraggable } from "@dnd-kit/core";
import { formatForDisplay, type Task } from "@planning/shared";
import { type StatusBadge, itemBadges } from "../../components/status";
import { Badge, ErrorText } from "../../components/ui";
import { usePlanView } from "../../workspace/ProjectContext";
import { planRows, referenceName, taskRecipients } from "./planRows";
import { type PlanItemDragData, usePlanDropTarget } from "../../workspace/panels";

function DraggableItem({
  task,
  planId,
  depth,
  kind,
  number,
  badges,
  displayName,
}: {
  task: Task;
  planId: string;
  depth: number;
  kind: string;
  /** Task ID in this plan; references have none. */
  number?: number;
  /** Ownership badges: EXT for this plan's external tasks, REF + link type for references. */
  badges: StatusBadge[];
  /** Shown name; for an external task it includes its owner plan. */
  displayName?: string;
}) {
  const name = displayName ?? task.name;
  const data: PlanItemDragData = {
    type: "plan-item",
    itemId: task.id,
    planId,
    name,
    external: task.ownership === "EXTERNAL",
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `plan-item:${planId}:${task.id}`,
    data,
  });
  return (
    <li
      ref={setNodeRef}
      className={`pp-outline-row${isDragging ? " pp-dragging" : ""}`}
      style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
      {...attributes}
      {...listeners}
    >
      <span className="pp-drag-handle" aria-hidden>
        ⋮⋮
      </span>
      <span className={`pp-kind-dot pp-kind-${kind}`} />
      <span className="pp-outline-id">{number ?? ""}</span>
      <span className="pp-outline-name">{name}</span>
      {badges.map((b) => (
        <Badge key={b.label} className={b.className} title={b.title}>
          {b.label}
        </Badge>
      ))}
      <span className="pp-outline-date">{formatForDisplay(task.start, task.granularity)}</span>
    </li>
  );
}

/** Only the ownership part of the Gantt's status badges. */
const ownershipBadges = (
  input: Pick<
    Parameters<typeof itemBadges>[0],
    "external" | "recipients" | "reference" | "linkType"
  >,
) => itemBadges({ ...input, pending: false, agreementState: "NONE", endVarianceDays: null });

export function PlanItemsView({ planId }: { planId: string }) {
  const { data: view, error } = usePlanView(planId);
  const drop = usePlanDropTarget("list", planId);
  if (!view) return <ErrorText error={error} />;
  const rows = planRows(view);
  return (
    <div ref={drop.setNodeRef} className={`pp-panel${drop.isOver ? " pp-drop-over" : ""}`}>
      <p className="pp-hint">
        Drag tasks into a timeline, or onto another plan's Gantt or task list to monitor them there.
      </p>
      <ul className="pp-outline">
        {rows.map((row) =>
          row.type === "task" ? (
            <DraggableItem
              key={row.task.id}
              task={row.task}
              planId={planId}
              depth={row.depth}
              kind={view.kinds[row.task.id] ?? "task"}
              number={row.task.taskNumber}
              badges={ownershipBadges({
                external: row.task.ownership === "EXTERNAL",
                recipients: taskRecipients(view, row.task.id),
                reference: false,
                linkType: null,
              })}
            />
          ) : (
            <DraggableItem
              key={row.reference.id}
              task={row.reference.item}
              displayName={referenceName(row.reference)}
              planId={row.reference.ownerPlanId}
              depth={row.depth}
              kind={row.reference.itemKind}
              number={row.reference.taskNumber}
              badges={ownershipBadges({
                external: true,
                recipients: [],
                reference: true,
                linkType: row.reference.linkType,
              })}
            />
          ),
        )}
      </ul>
    </div>
  );
}
