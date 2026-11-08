/**
 * Multi-panel workspace (Dockview). The layout is serialised and saved as the
 * user's Workspace. One dnd-kit DndContext spans all panels, so items can be
 * dragged from a plan panel into a timeline panel.
 */
import { useCallback, useMemo, useRef, useState, type FunctionComponent } from "react";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  type CollisionDetection,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Link } from "react-router-dom";
import { type WorkspaceViewState, addCalendarUnits, nowIso, startOfUnit } from "@planning/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ErrorText } from "../components/ui";
import { ApprovalInbox } from "../views/approvals/ApprovalInbox";
import { BaselinesView } from "../views/approvals/BaselinesView";
import { CalendarView } from "../views/calendar/CalendarView";
import { GanttView } from "../views/gantt/GanttView";
import { PlanItemsView } from "../views/gantt/PlanItemsView";
import { ProjectView } from "../views/project/ProjectView";
import { ReportsView } from "../views/reports/ReportsView";
import {
  TimelineView,
  dropOnTimeline,
  highlightTimelineDrop,
} from "../views/timeline/TimelineView";
import { useLive, useProject } from "./ProjectContext";
import {
  type PanelKind,
  type PanelParams,
  type PlanDropData,
  type PlanItemDragData,
  type TimelineDropData,
  type WorkspaceActions,
  WorkspaceActionsContext,
} from "./panels";

type Props<K extends PanelKind> = IDockviewPanelProps<PanelParams[K]>;

const components: Record<PanelKind, FunctionComponent<IDockviewPanelProps>> = {
  gantt: (p: Props<"gantt">) => <GanttView planId={p.params.planId} />,
  planItems: (p: Props<"planItems">) => <PlanItemsView planId={p.params.planId} />,
  timeline: (p: Props<"timeline">) => <TimelineView timelineId={p.params.timelineId} />,
  calendar: (p: Props<"calendar">) => <CalendarView planIds={p.params.planIds ?? []} />,
  approvals: () => <ApprovalInbox />,
  baselines: (p: Props<"baselines">) => <BaselinesView planId={p.params.planId} />,
  reports: () => <ReportsView />,
  project: () => <ProjectView />,
};

const SAVE_DELAY_MS = 1000;

/** Drop on what is under the pointer; else on the largest overlap. */
const dropUnderPointer: CollisionDetection = (args) => {
  const underPointer = pointerWithin(args);
  return underPointer.length > 0 ? underPointer : rectIntersection(args);
};

/** Where the pointer is now, from where the drag started. */
const pointerOf = (e: DragMoveEvent | DragEndEvent) => {
  const start = e.activatorEvent as PointerEvent;
  return { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
};

export function ProjectWorkspace() {
  const { project, plans } = useProject();
  const { user, signOut } = useAuth();
  const dockRef = useRef<DockviewApi | null>(null);
  const workspaceRef = useRef<{ id: string; version: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<PlanItemDragData | null>(null);
  // The project itself starts expanded until the user's saved state is loaded.
  const [viewState, setViewState] = useState<WorkspaceViewState>({
    expandedProjectIds: [project.id],
  });
  const viewStateRef = useRef(viewState);
  const { data: timelines, reload: reloadTimelines } = useLive(
    () => api.timelines.list(project.id),
    (c) => c.entityType === "timeline",
    [project.id],
  );
  const { data: pending } = useLive(
    () => api.changeRequests.pending(project.id, true),
    (c) => c.entityType === "changeRequest",
    [project.id],
  );

  const openPanel = useCallback<WorkspaceActions["openPanel"]>((kind, params, title) => {
    const dock = dockRef.current;
    if (!dock) return;
    const id = `${kind}:${JSON.stringify(params)}`;
    const existing = dock.getPanel(id);
    if (existing) existing.api.setActive();
    else dock.addPanel({ id, component: kind, params, title });
  }, []);
  const saveLayout = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const dock = dockRef.current;
      if (!dock) return;
      const input = {
        name: "Default",
        layout: dock.toJSON(),
        viewState: viewStateRef.current,
        version: workspaceRef.current?.version,
      };
      const save = workspaceRef.current
        ? api.workspaces.update(project.id, workspaceRef.current.id, input)
        : api.workspaces.create(project.id, input);
      save
        .then((w) => (workspaceRef.current = { id: w.id, version: w.version }))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, SAVE_DELAY_MS);
  }, [project.id]);

  const setProjectExpanded = useCallback(
    (projectId: string, expanded: boolean) => {
      const ids = viewStateRef.current.expandedProjectIds.filter((id) => id !== projectId);
      viewStateRef.current = { expandedProjectIds: expanded ? [...ids, projectId] : ids };
      setViewState(viewStateRef.current);
      saveLayout();
    },
    [saveLayout],
  );
  const planChanged = useCallback((planId: string, oldName: string, newName: string | null) => {
    const dock = dockRef.current;
    if (!dock) return;
    for (const panel of [...dock.panels]) {
      if ((panel.params as { planId?: string } | undefined)?.planId !== planId) continue;
      if (newName === null) panel.api.close();
      else panel.api.setTitle(panel.title?.replace(oldName, newName) ?? newName);
    }
  }, []);
  const actions = useMemo(
    () => ({
      openPanel,
      expandedProjectIds: viewState.expandedProjectIds,
      setProjectExpanded,
      planChanged,
    }),
    [openPanel, viewState, setProjectExpanded, planChanged],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      dockRef.current = event.api;
      void (async () => {
        const [saved] = await api.workspaces.list(project.id).catch(() => []);
        if (saved) {
          workspaceRef.current = { id: saved.id, version: saved.version };
          if (saved.viewState) {
            viewStateRef.current = saved.viewState;
            setViewState(saved.viewState);
          }
          try {
            if (saved.layout)
              event.api.fromJSON(saved.layout as Parameters<DockviewApi["fromJSON"]>[0]);
          } catch {
            event.api.clear();
          }
        }
        if (event.api.panels.length === 0) {
          event.api.addPanel({
            id: "project:{}",
            component: "project",
            params: {},
            title: "Project",
          });
          const first = (await api.plans.list(project.id))[0];
          if (first)
            event.api.addPanel({
              id: `gantt:${JSON.stringify({ planId: first.id })}`,
              component: "gantt",
              params: { planId: first.id },
              title: first.name,
            });
        }
        event.api.onDidLayoutChange(saveLayout);
      })();
    },
    [project.id, saveLayout],
  );

  const createTimeline = async () => {
    const name = window.prompt("Timeline name", "Roadmap");
    if (!name) return;
    const start = startOfUnit(nowIso(), "months");
    try {
      const t = await api.timelines.create(project.id, {
        name,
        start,
        end: addCalendarUnits(start, 12, "months"),
        scale: "months",
        rows: [{ id: crypto.randomUUID(), name: "Row 1" }],
      });
      await reloadTimelines();
      openPanel("timeline", { timelineId: t.id }, t.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Use a task in another plan (also of a subproject) for monitoring. */
  const monitorInPlan = async (item: PlanItemDragData, planId: string) => {
    if (!item.external) {
      // Only external tasks can be used in other plans (CLAUDE.md §4).
      if (!window.confirm(`Make '${item.name}' external so it can be monitored in other plans?`))
        return;
      const task = await api.items.get(item.itemId);
      await api.items.update(task.id, { version: task.version, ownership: "EXTERNAL" });
    }
    await api.items.addReference({ itemId: item.itemId, planId, linkType: "MONITOR" });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragStart = (e: DragStartEvent) =>
    setDragging((e.active.data.current as PlanItemDragData | undefined) ?? null);
  const onDragMove = (e: DragMoveEvent) => {
    const target = e.over?.data.current as TimelineDropData | PlanDropData | undefined;
    highlightTimelineDrop(
      target?.type === "timeline" ? { timelineId: target.timelineId, point: pointerOf(e) } : null,
    );
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    highlightTimelineDrop(null);
    const item = e.active.data.current as PlanItemDragData | undefined;
    const target = e.over?.data.current as TimelineDropData | PlanDropData | undefined;
    const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
    if (item?.type !== "plan-item") return;
    if (target?.type === "timeline")
      dropOnTimeline(target.timelineId, pointerOf(e), item).catch(fail);
    if (target?.type === "plan" && target.planId !== item.planId)
      void monitorInPlan(item, target.planId).then(() => setError(null), fail);
  };
  const onDragCancel = () => {
    setDragging(null);
    highlightTimelineDrop(null);
  };

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <div className="pp-workspace">
        <nav className="pp-topbar">
          <Link to="/" className="pp-brand">
            Planner
          </Link>
          <span className="pp-project-name">{project.name}</span>
          <details className="pp-menu">
            <summary>Plans</summary>
            <div className="pp-menu-body">
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openPanel("gantt", { planId: p.id }, p.name)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </details>
          <details className="pp-menu">
            <summary>Timelines</summary>
            <div className="pp-menu-body">
              {timelines?.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openPanel("timeline", { timelineId: t.id }, t.name)}
                >
                  {t.name}
                </button>
              ))}
              <button type="button" onClick={() => void createTimeline()}>
                + New timeline
              </button>
            </div>
          </details>
          <button type="button" onClick={() => openPanel("calendar", { planIds: [] }, "Calendar")}>
            Calendar
          </button>
          <button type="button" onClick={() => openPanel("approvals", {}, "Approvals")}>
            Approvals{pending?.length ? <span className="pp-count">{pending.length}</span> : null}
          </button>
          <button type="button" onClick={() => openPanel("reports", {}, "Reports")}>
            Reports
          </button>
          <button type="button" onClick={() => openPanel("project", {}, "Project")}>
            Project
          </button>
          <span className="pp-spacer" />
          <span className="pp-user">{user?.displayName}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
        <ErrorText error={error} />
        <DndContext
          sensors={sensors}
          collisionDetection={dropUnderPointer}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div className="pp-dock">
            <DockviewReact components={components} onReady={onReady} theme={themeLight} />
          </div>
          <DragOverlay>
            {dragging ? <div className="pp-drag-chip">{dragging.name}</div> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </WorkspaceActionsContext.Provider>
  );
}
