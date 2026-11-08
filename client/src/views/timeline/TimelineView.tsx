/**
 * User-configurable timeline, drawn by ar-timeline-view: name, span, scale and
 * rows. It can show tasks of any project the user can read. Tasks are dragged
 * in from plans and stored as references (dates are read live). The library
 * handles moving entries between lines, areas and rows; every change it
 * reports is saved through the server, which remains the source of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  MoveError,
  type TaskData,
  type TimelineData,
  type TimelineTemplates,
  type TimelineView as TimelineCanvas,
  type TimelineViewData,
} from "ar-timeline-view";
import { Timeline as TimelineComponent } from "ar-timeline-view/react";
import "ar-timeline-view/timelineview.css";
import {
  GRANULARITIES,
  type Granularity,
  type Task,
  type Timeline,
  type UpdateTimelineInput,
  formatForDisplay,
  fromDateInputValue,
  toDateInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { PENDING_BADGE } from "../../components/status";
import { ErrorText, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import type { PlanItemDragData, TimelineDropData } from "../../workspace/panels";
import {
  type LayerSpan,
  type TimelineProposal,
  type TimelineTaskStatus,
  entriesFromView,
  proposalBox,
  rowsFromView,
  sameDrawing,
  statusOfTask,
  taskStatuses,
  toTaskData,
  toViewData,
} from "./layout";

/** What the workspace's DndContext can do with an open timeline panel. */
interface TimelineDropHandle {
  highlight(point: { x: number; y: number } | null): void;
  drop(point: { x: number; y: number }, item: PlanItemDragData): Promise<void>;
}

const openTimelines = new Map<string, TimelineDropHandle>();

/** Show where a dragged plan task would land; `null` clears every timeline's highlight. */
export function highlightTimelineDrop(
  target: { timelineId: string; point: { x: number; y: number } } | null,
): void {
  if (!target) for (const handle of openTimelines.values()) handle.highlight(null);
  else openTimelines.get(target.timelineId)?.highlight(target.point);
}

/** Add a dragged plan task at the pointer (called by the workspace's DndContext). */
export async function dropOnTimeline(
  timelineId: string,
  point: { x: number; y: number },
  item: PlanItemDragData,
): Promise<void> {
  await openTimelines.get(timelineId)?.drop(point, item);
}

interface Loaded {
  timeline: Timeline;
  items: Map<string, Task>;
  statuses: Map<string, TimelineTaskStatus>;
}

async function load(timelineId: string): Promise<Loaded> {
  const timeline = await api.timelines.get(timelineId);
  const items = new Map<string, Task>();
  for (const id of new Set(timeline.entries.map((e) => e.itemId))) {
    const item = await api.items.get(id).catch(() => null);
    if (item) items.set(id, item);
  }
  // A plan the user cannot read just gives its tasks no status.
  const views = await Promise.all(
    [...new Set(timeline.entries.map((e) => e.planId))].map((id) =>
      api.plans.view(id).catch(() => null),
    ),
  );
  return { timeline, items, statuses: taskStatuses(views.filter((v) => v !== null)) };
}

/** A task's dates, snapped to its own granularity. */
function datesOf(start: Date, end: Date, granularity: Granularity): string {
  const first = formatForDisplay(start.toISOString(), granularity);
  return start.getTime() === end.getTime()
    ? first
    : `${first} – ${formatForDisplay(end.toISOString(), granularity)}`;
}

/** A task's name, after a PEND badge if it has a pending request (narrow bars clip the end). */
function labelOf(task: TaskData): DocumentFragment {
  const content = document.createDocumentFragment();
  if (statusOfTask(task).pending) {
    const badge = document.createElement("span");
    badge.className = `pp-badge ${PENDING_BADGE.className}`;
    badge.textContent = PENDING_BADGE.label;
    content.append(badge);
  }
  content.append(task.text);
  return content;
}

function proposalText(p: TimelineProposal): string {
  const dates = datesOf(new Date(p.start), new Date(p.end), p.granularity);
  return `Proposed: ${dates}${p.description ? ` (${p.description})` : ""}`;
}

// DOM nodes, not HTML strings: task names are user input.
const templates: TimelineTemplates = {
  task_text: (_start, _end, task) => labelOf(task),
  milestone_text: (_start, _end, task) => labelOf(task),
  callout_text: (start, end, task) => {
    const title = document.createElement("div");
    title.className = "tlv-callout-title";
    title.append(labelOf(task));
    const dates = document.createElement("div");
    dates.className = "tlv-callout-dates";
    dates.textContent = datesOf(start, end, task.granularity as Granularity);
    const content = document.createDocumentFragment();
    content.append(title, dates);
    return content;
  },
  tooltip_text: (start, end, item) => {
    const task = item as TaskData;
    const { pending, proposals } = statusOfTask(task);
    return document.createTextNode(
      [
        `${item.text}: ${datesOf(start, end, (task.granularity as Granularity | undefined) ?? "days")}`,
        ...(pending ? [PENDING_BADGE.title] : []),
        ...proposals.map(proposalText),
      ].join("\n"),
    );
  },
};

/** One task's proposals, as dashed outlines placed by `locate`. */
function proposalOutlines(
  task: TaskData,
  grow: number,
  locate: (p: TimelineProposal) => LayerSpan | null,
): HTMLElement | null {
  const { proposals } = statusOfTask(task);
  if (proposals.length === 0) return null;
  const layer = document.createElement("div");
  for (const p of proposals) {
    const span = locate(p);
    if (!span) continue;
    const box = proposalBox(span, p.milestone, grow);
    const outline = document.createElement("div");
    outline.className = `pp-tl-proposal ${p.milestone ? "pp-tl-proposal-diamond" : ""}`;
    outline.style.left = `${box.left}px`;
    outline.style.top = `${box.top}px`;
    outline.style.width = `${box.width}px`;
    outline.style.height = `${box.height}px`;
    layer.append(outline);
  }
  return layer;
}

/** A bar line is 28 px high, so its outline stays just inside it. */
const BAR_OUTLINE_GROW = -1;
/** A callout's marker on the bar's edge is thin, so its outline goes around it. */
const CALLOUT_OUTLINE_GROW = 2;

function drawBarProposals(this: TimelineCanvas, task: TaskData, timeline: TimelineData) {
  return proposalOutlines(task, BAR_OUTLINE_GROW, (p) =>
    this.getTaskPosition(task, timeline, p.start, p.end),
  );
}

function drawCalloutProposals(this: TimelineCanvas, task: TaskData, timeline: TimelineData) {
  return proposalOutlines(task, CALLOUT_OUTLINE_GROW, (p) =>
    this.getCalloutPosition(task, timeline, p.start, p.end),
  );
}

function drawnAlready(view: TimelineCanvas | null, data: TimelineViewData): boolean {
  try {
    return view !== null && sameDrawing(view.serialize(), data);
  } catch {
    return false; // mounted, but nothing has been drawn yet
  }
}

export function TimelineView({ timelineId }: { timelineId: string }) {
  const { data, error, reload } = useLive(
    () => load(timelineId),
    (c) =>
      (c.entityType === "timeline" && c.entityId === timelineId) ||
      c.entityType === "task" ||
      c.entityType === "changeRequest",
    [timelineId],
  );
  const { error: actionError, setError, run } = useAction();
  const [newRow, setNewRow] = useState("");
  const [shown, setShown] = useState<TimelineViewData | null>(null);
  const canvas = useRef<TimelineCanvas | null>(null);
  const attachCanvas = useCallback((view: TimelineCanvas | null) => {
    canvas.current = view;
    view?.addTaskLayer(drawBarProposals);
    view?.addCalloutLayer(drawCalloutProposals);
  }, []);
  // Saves run one at a time, in the order the changes were made.
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const savesRunning = useRef(0);
  const plansOfDropped = useRef(new Map<string, string>());
  const { setNodeRef } = useDroppable({
    id: `timeline:${timelineId}`,
    data: { type: "timeline", timelineId } satisfies TimelineDropData,
  });

  // Tasks can come from other projects: keep them live too.
  const { watchProject } = useProject();
  const itemProjects = [...new Set([...(data?.items.values() ?? [])].map((t) => t.projectId))];
  const itemProjectsKey = itemProjects.join(",");
  useEffect(() => {
    for (const id of itemProjectsKey ? itemProjectsKey.split(",") : []) watchProject(id);
  }, [itemProjectsKey, watchProject]);

  // Drawing replaces the view's DOM, so it waits for a drag and for running saves;
  // both reload afterwards. Data the view already shows is not drawn again.
  const viewData = useMemo(
    () => (data ? toViewData(data.timeline, data.items, data.statuses) : null),
    [data],
  );
  useEffect(() => {
    if (!viewData || canvas.current?.isDragging() || savesRunning.current > 0) return;
    if (!drawnAlready(canvas.current, viewData)) setShown(viewData);
  }, [viewData]);

  /** Save a change on top of the latest stored timeline, after the changes before it. */
  const save = (change: (latest: Timeline) => Omit<UpdateTimelineInput, "version">) => {
    savesRunning.current += 1;
    const done = saves.current
      .then(() =>
        run(async () => {
          const latest = await api.timelines.get(timelineId);
          await api.timelines.update(timelineId, { version: latest.version, ...change(latest) });
        }),
      )
      .then(async () => {
        savesRunning.current -= 1;
        if (savesRunning.current === 0) await reload();
      });
    saves.current = done;
    return done;
  };
  const saveEntries = () => {
    const snapshot = canvas.current?.serialize();
    if (!snapshot) return;
    void save((latest) => ({
      entries: entriesFromView(snapshot, latest.entries, plansOfDropped.current, () =>
        crypto.randomUUID(),
      ),
    }));
  };
  const saveRows = () => {
    const snapshot = canvas.current?.serialize();
    if (snapshot) void save(() => ({ rows: rowsFromView(snapshot) }));
  };

  const handle = useRef<TimelineDropHandle>({
    highlight: (point) => {
      const view = canvas.current;
      if (view) view.highlightTarget(point && view.targetAt(point.x, point.y));
    },
    drop: async (point, item) => {
      const view = canvas.current;
      if (!view) return;
      const task = toTaskData(await api.items.get(item.itemId));
      const known = view.serialize().tasks.some((t) => t.id === task.id);
      const added = known ? task.id : task;
      const target = view.targetAt(point.x, point.y, added);
      if (!target) return;
      plansOfDropped.current.set(item.itemId, item.planId);
      await view.addEntry(added, target).catch((err: unknown) => {
        // A task can be on a row only once; dropping it there again does nothing.
        if (!(err instanceof MoveError && err.code === "conflict")) throw err;
      });
    },
  });
  useEffect(() => {
    const current = handle.current;
    openTimelines.set(timelineId, current);
    return () => {
      if (openTimelines.get(timelineId) === current) openTimelines.delete(timelineId);
    };
  }, [timelineId]);

  if (!data) return <ErrorText error={error} />;
  const { timeline } = data;

  return (
    <div className="pp-panel pp-timeline" ref={setNodeRef}>
      <div className="pp-toolbar">
        <input
          className="pp-title-input"
          defaultValue={timeline.name}
          onBlur={(e) => e.target.value !== timeline.name && save(() => ({ name: e.target.value }))}
          aria-label="Timeline title"
        />
        <input
          type="date"
          value={toDateInputValue(timeline.start)}
          onChange={(e) =>
            e.target.value && save(() => ({ start: fromDateInputValue(e.target.value) }))
          }
          aria-label="Start"
        />
        <input
          type="date"
          value={toDateInputValue(timeline.end)}
          onChange={(e) =>
            e.target.value && save(() => ({ end: fromDateInputValue(e.target.value) }))
          }
          aria-label="End"
        />
        <select
          value={timeline.scale}
          onChange={(e) => save(() => ({ scale: e.target.value as Granularity }))}
          aria-label="Scale"
        >
          {GRANULARITIES.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <span className="pp-spacer" />
        <input placeholder="New row" value={newRow} onChange={(e) => setNewRow(e.target.value)} />
        <button
          type="button"
          disabled={!newRow}
          onClick={() =>
            save((latest) => ({
              rows: [...latest.rows, { id: crypto.randomUUID(), name: newRow }],
            })).then(() => setNewRow(""))
          }
        >
          Add row
        </button>
      </div>
      <ErrorText error={actionError} />
      {shown && (
        <TimelineComponent
          ref={attachCanvas}
          data={shown}
          controls
          templates={templates}
          onEntryMoved={saveEntries}
          onEntryAdded={saveEntries}
          onEntryRemoved={saveEntries}
          onTimelineMoved={saveRows}
          onTimelineRenamed={saveRows}
          onMoveFailed={() => void reload()}
          onDraggingEnded={() => void saves.current.then(reload)}
          onError={(err) => setError(err instanceof Error ? err.message : String(err))}
        />
      )}
    </div>
  );
}
