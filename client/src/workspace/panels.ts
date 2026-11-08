import { createContext, useContext } from "react";
import { useDroppable } from "@dnd-kit/core";

/** Panel kinds of the Dockview workspace and their parameters. */
export interface PanelParams {
  gantt: { planId: string };
  planItems: { planId: string };
  timeline: { timelineId: string };
  calendar: { planIds: string[] };
  approvals: Record<string, never>;
  baselines: { planId: string };
  reports: Record<string, never>;
  project: Record<string, never>;
}

export type PanelKind = keyof PanelParams;

export interface WorkspaceActions {
  openPanel<K extends PanelKind>(kind: K, params: PanelParams[K], title: string): void;
  /** Projects expanded in the Project panel's tree (saved with the workspace). */
  expandedProjectIds: string[];
  setProjectExpanded(projectId: string, expanded: boolean): void;
  /** A plan was renamed (`newName`) or deleted (null): retitle or close its panels. */
  planChanged(planId: string, oldName: string, newName: string | null): void;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions>({
  openPanel: () => undefined,
  expandedProjectIds: [],
  setProjectExpanded: () => undefined,
  planChanged: () => undefined,
});

export function useWorkspaceActions(): WorkspaceActions {
  return useContext(WorkspaceActionsContext);
}

/** Drag payloads shared by dnd-kit sources and drop targets across panels. */
export interface PlanItemDragData {
  type: "plan-item";
  itemId: string;
  /** Plan the task belongs to (its owner plan). */
  planId: string;
  name: string;
  external: boolean;
}

/** A plan panel (Gantt or task list) that accepts tasks from other plans for monitoring. */
export interface PlanDropData {
  type: "plan";
  planId: string;
}

/** Make a panel a drop target for tasks of other plans; `isOver` only for such tasks. */
export function usePlanDropTarget(panel: string, planId: string) {
  const data: PlanDropData = { type: "plan", planId };
  const { setNodeRef, isOver, active } = useDroppable({ id: `plan:${panel}:${planId}`, data });
  const dragged = active?.data.current as PlanItemDragData | undefined;
  return {
    setNodeRef,
    isOver: isOver && dragged?.type === "plan-item" && dragged.planId !== planId,
  };
}

/** An open timeline panel; the view finds the exact spot from the pointer position. */
export interface TimelineDropData {
  type: "timeline";
  timelineId: string;
}
