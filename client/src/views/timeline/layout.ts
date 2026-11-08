/**
 * Conversion between our timelines and the ar-timeline-view data format: a
 * Timeline is one view, each of its rows a timeline of that view.
 */
import type { Id, Scale, TaskData, TimelineViewData } from "ar-timeline-view";
import type {
  Granularity,
  PlanView,
  Task,
  Timeline,
  TimelineEntry,
  TimelineRow,
} from "@planning/shared";

const SCALES: Record<Granularity, Scale> = {
  hours: "hour",
  days: "day",
  weeks: "week",
  months: "month",
  years: "year",
};

/** A pending change to a task, at the dates it proposes. */
export interface TimelineProposal {
  start: string;
  end: string;
  granularity: Granularity;
  /** Proposes zero duration: drawn as a diamond instead of a rectangle. */
  milestone: boolean;
  description: string;
}

export interface TimelineTaskStatus {
  /** The task has a pending ChangeRequest of any kind, as the Gantt's PEND badge. */
  pending: boolean;
  proposals: TimelineProposal[];
}

/** Pending state per task, from the views of the plans owning the timeline's tasks. */
export function taskStatuses(
  views: Pick<PlanView, "pendingItemIds" | "proposedChanges">[],
): Map<string, TimelineTaskStatus> {
  const statuses = new Map<string, TimelineTaskStatus>();
  const statusOf = (itemId: string) => {
    const status = statuses.get(itemId) ?? { pending: false, proposals: [] };
    statuses.set(itemId, status);
    return status;
  };
  for (const view of views) for (const id of view.pendingItemIds) statusOf(id).pending = true;
  const seen = new Set<string>();
  for (const change of views.flatMap((v) => v.proposedChanges)) {
    if (seen.has(change.changeRequestId)) continue;
    seen.add(change.changeRequestId);
    const { itemId, start, end, granularity, duration } = change.proposed;
    statusOf(itemId).proposals.push({
      start,
      end,
      granularity,
      milestone: duration === 0,
      description: change.description,
    });
  }
  return statuses;
}

/** The status carried on a library task (as custom attributes). */
export function statusOfTask(task: TaskData): TimelineTaskStatus {
  return {
    pending: task.pending === true,
    proposals: (task.proposals as TimelineProposal[] | undefined) ?? [],
  };
}

/** The part of a library layer's position that places an element. */
export interface LayerSpan {
  left: number;
  top: number;
  width: number;
  height: number;
}

const OUTLINE_MARGIN = 2;
const MIN_OUTLINE_WIDTH = 8;
const DIAMOND_SIZE = 14;

/**
 * Where to draw a proposal: around its date span, or a diamond centred on its
 * date. `grow` changes the outline's height on each side (a bar line is tall,
 * a callout's marker on the bar's edge is thin).
 */
export function proposalBox(span: LayerSpan, milestone: boolean, grow: number): LayerSpan {
  if (milestone)
    return {
      left: span.left - DIAMOND_SIZE / 2,
      top: span.top + span.height / 2 - DIAMOND_SIZE / 2,
      width: DIAMOND_SIZE,
      height: DIAMOND_SIZE,
    };
  return {
    left: span.left - OUTLINE_MARGIN,
    top: span.top - grow,
    width: Math.max(span.width, MIN_OUTLINE_WIDTH) + 2 * OUTLINE_MARGIN,
    height: span.height + 2 * grow,
  };
}

/** The library's task: live values of the plan task, read-only for the timeline. */
export function toTaskData(item: Task, status?: TimelineTaskStatus): TaskData {
  return {
    id: item.id,
    text: item.name,
    start_date: item.start,
    ...(item.duration === 0 ? {} : { finish_date: item.end }),
    granularity: item.granularity,
    ...(status?.pending ? { pending: true } : {}),
    ...(status?.proposals.length ? { proposals: status.proposals } : {}),
  };
}

/** Entries whose task could not be loaded are left out: the library rejects unknown tasks. */
export function toViewData(
  timeline: Timeline,
  items: Map<string, Task>,
  statuses: ReadonlyMap<string, TimelineTaskStatus> = new Map(),
): TimelineViewData {
  return {
    view: {
      name: "",
      scale: SCALES[timeline.scale],
      show_dates: false,
      compact_lines: true,
      selection: false,
    },
    tasks: [...items.values()].map((item) => toTaskData(item, statuses.get(item.id))),
    timelines: timeline.rows.map((row) => ({
      id: row.id,
      name: row.name,
      start_date: timeline.start,
      finish_date: timeline.end,
      entries: timeline.entries
        .filter((e) => e.rowId === row.id && items.has(e.itemId))
        .map((e) =>
          e.placement === "on"
            ? { task: e.itemId, line: e.line }
            : { task: e.itemId, callout_offset: { x: e.calloutX ?? 0, y: e.calloutY ?? 0 } },
        ),
    })),
  };
}

const instant = (date: string | undefined) => (date ? new Date(date).getTime() : null);

/** What decides how a view looks; offsets are compared as they are stored (whole px). */
function drawing(data: TimelineViewData): unknown {
  return {
    scale: data.view.scale,
    tasks: data.tasks.map((t) => [
      t.id,
      t.text,
      instant(t.start_date),
      instant(t.finish_date),
      t.granularity,
      statusOfTask(t),
    ]),
    timelines: data.timelines.map((t) => [
      t.id,
      t.name,
      instant(t.start_date),
      instant(t.finish_date),
      t.entries.flatMap((e) =>
        "task" in e
          ? [
              e.callout_offset
                ? [e.task, Math.round(e.callout_offset.x), Math.round(e.callout_offset.y)]
                : [e.task, e.line ?? 0],
            ]
          : [],
      ),
    ]),
  };
}

/** Whether two views look the same, whatever order or date format their data uses. */
export function sameDrawing(a: TimelineViewData, b: TimelineViewData): boolean {
  const key = (data: TimelineViewData) => JSON.stringify(drawing(sortedForDrawing(data)));
  return key(a) === key(b);
}

const byId = (a: { id: Id }, b: { id: Id }) => String(a.id).localeCompare(String(b.id));
const byTask = <E extends object>(a: E, b: E) =>
  ("task" in a ? String(a.task) : "").localeCompare("task" in b ? String(b.task) : "");

function sortedForDrawing(data: TimelineViewData): TimelineViewData {
  return {
    ...data,
    tasks: [...data.tasks].sort(byId),
    // Row order is what the user sees, so only the entries within a row are sorted.
    timelines: data.timelines.map((t) => ({ ...t, entries: [...t.entries].sort(byTask) })),
  };
}

export function rowsFromView(data: TimelineViewData): TimelineRow[] {
  return data.timelines.map((t) => ({ id: String(t.id), name: t.name }));
}

/**
 * The entries as the view now has them. Existing entries keep their id and
 * plan: the entry of that task in the same row, else one it was moved from.
 * Entries the view could not show (their task is not readable) are kept.
 */
export function entriesFromView(
  data: TimelineViewData,
  previous: TimelineEntry[],
  planOfNew: ReadonlyMap<Id, string>,
  newId: () => string,
): TimelineEntry[] {
  const placed = data.timelines.flatMap((t) =>
    t.entries.flatMap((entry) =>
      "task" in entry ? [{ rowId: String(t.id), itemId: String(entry.task), entry }] : [],
    ),
  );
  const unclaimed = new Map(previous.map((e) => [e.id, e]));
  const claim = (matches: (e: TimelineEntry) => boolean): TimelineEntry | undefined => {
    const found = [...unclaimed.values()].find(matches);
    if (found) unclaimed.delete(found.id);
    return found;
  };
  const inSameRow = placed.map((p) => claim((e) => e.itemId === p.itemId && e.rowId === p.rowId));
  const entries = placed.flatMap((p, index): TimelineEntry[] => {
    const old = inSameRow[index] ?? claim((e) => e.itemId === p.itemId);
    const planId =
      old?.planId ?? planOfNew.get(p.itemId) ?? previous.find((e) => e.itemId === p.itemId)?.planId;
    if (!planId) return [];
    const base = { id: old?.id ?? newId(), rowId: p.rowId, itemId: p.itemId, planId };
    const offset = p.entry.callout_offset;
    if (!offset) return [{ ...base, placement: "on", line: p.entry.line ?? 0 }];
    return [
      {
        ...base,
        placement: offset.y > 0 ? "below" : "above",
        line: 0,
        calloutX: Math.round(offset.x),
        // Rounding must not move a callout to the other side of the bar.
        calloutY: offset.y > 0 ? Math.max(1, Math.round(offset.y)) : Math.round(offset.y),
      },
    ];
  });
  const shown = new Set(data.tasks.map((t) => String(t.id)));
  return [...entries, ...[...unclaimed.values()].filter((e) => !shown.has(e.itemId))];
}
