import { describe, expect, it } from "vitest";
import type { TimelineViewData } from "ar-timeline-view";
import type { PlanView, Task, Timeline, TimelineEntry } from "@planning/shared";
import {
  entriesFromView,
  proposalBox,
  rowsFromView,
  sameDrawing,
  statusOfTask,
  taskStatuses,
  toTaskData,
  toViewData,
} from "./layout";

const task = (id: string, fields: Partial<Task> = {}): Task =>
  ({
    id,
    name: `Task ${id}`,
    start: "2026-04-01T00:00:00.000Z",
    end: "2026-04-03T00:00:00.000Z",
    duration: 2,
    granularity: "days",
    ...fields,
  }) as Task;

const entry = (id: string, itemId: string, fields: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id,
  rowId: "r1",
  itemId,
  planId: "p",
  placement: "on",
  line: 0,
  ...fields,
});

const timeline = (entries: TimelineEntry[]): Timeline =>
  ({
    id: "t",
    name: "Roadmap",
    start: "2026-01-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z",
    scale: "months",
    rows: [
      { id: "r1", name: "One" },
      { id: "r2", name: "Two" },
    ],
    entries,
  }) as Timeline;

const view = (entries: Record<string, TimelineViewData["timelines"][number]["entries"]>) =>
  ({
    view: { name: "" },
    tasks: [{ id: "a", text: "A", start_date: "2026-04-01" }],
    timelines: Object.entries(entries).map(([id, list]) => ({
      id,
      name: id.toUpperCase(),
      start_date: "2026-01-01",
      finish_date: "2027-01-01",
      entries: list,
    })),
  }) as TimelineViewData;

const newId = () => "new";
const noPlans = new Map<string, string>();

describe("timeline to view data", () => {
  it("draws zero-duration tasks as milestones and carries the granularity", () => {
    expect(toTaskData(task("a"))).toMatchObject({
      finish_date: "2026-04-03T00:00:00.000Z",
      granularity: "days",
    });
    expect(toTaskData(task("m", { duration: 0 }))).not.toHaveProperty("finish_date");
  });

  it("gives each row the timeline's span and places bars and callouts", () => {
    const data = toViewData(
      timeline([
        entry("e1", "a", { line: 2 }),
        entry("e2", "b", { rowId: "r2", placement: "above", calloutX: 30, calloutY: -40 }),
      ]),
      new Map([
        ["a", task("a")],
        ["b", task("b")],
      ]),
    );
    expect(data.view.scale).toBe("month");
    expect(data.timelines[0]).toMatchObject({
      start_date: "2026-01-01T00:00:00.000Z",
      entries: [{ task: "a", line: 2 }],
    });
    expect(data.timelines[1]?.entries).toEqual([{ task: "b", callout_offset: { x: 30, y: -40 } }]);
  });

  it("leaves out entries whose task could not be loaded", () => {
    const data = toViewData(timeline([entry("e1", "gone")]), new Map());
    expect(data.timelines[0]?.entries).toEqual([]);
  });
});

describe("pending state and proposals", () => {
  const change = (changeRequestId: string, itemId: string, duration = 3) =>
    ({
      changeRequestId,
      planId: "recipient",
      description: "Longer",
      proposed: {
        itemId,
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-04T00:00:00.000Z",
        duration,
        granularity: "days",
      },
    }) as PlanView["proposedChanges"][number];

  it("merges plan views, counting a proposal shown in two plans once", () => {
    const statuses = taskStatuses([
      { pendingItemIds: ["a", "b"], proposedChanges: [change("cr1", "a")] },
      { pendingItemIds: ["a"], proposedChanges: [change("cr1", "a"), change("cr2", "a", 0)] },
    ]);
    expect(statuses.get("b")).toEqual({ pending: true, proposals: [] });
    expect(statuses.get("a")?.pending).toBe(true);
    expect(statuses.get("a")?.proposals.map((p) => p.milestone)).toEqual([false, true]);
  });

  it("carries the status on the library's task, and reads it back", () => {
    const status = taskStatuses([
      { pendingItemIds: ["a"], proposedChanges: [change("cr1", "a")] },
    ]).get("a")!;
    expect(statusOfTask(toTaskData(task("a"), status))).toEqual(status);
    expect(statusOfTask(toTaskData(task("a")))).toEqual({ pending: false, proposals: [] });
  });

  it("redraws when a task's proposals or pending state change", () => {
    const entries = timeline([entry("e1", "a")]);
    const items = new Map([["a", task("a")]]);
    const plain = toViewData(entries, items);
    const proposed = toViewData(
      entries,
      items,
      taskStatuses([{ pendingItemIds: ["a"], proposedChanges: [change("cr1", "a")] }]),
    );
    expect(sameDrawing(plain, proposed)).toBe(false);
    expect(sameDrawing(proposed, structuredClone(proposed))).toBe(true);
  });

  const span = { left: 100, top: 10, width: 50, height: 6 };

  it("draws a rectangle around the proposed span, wide enough to see", () => {
    expect(proposalBox(span, false, 2)).toEqual({ left: 98, top: 8, width: 54, height: 10 });
    expect(proposalBox({ ...span, width: 0 }, false, -1).width).toBe(12);
  });

  it("centres a diamond on the proposed date", () => {
    expect(proposalBox({ ...span, width: 0 }, true, 2)).toEqual({
      left: 93,
      top: 6,
      width: 14,
      height: 14,
    });
  });
});

describe("comparing what is drawn", () => {
  const base = view({ r1: [{ task: "a", callout_offset: { x: 10, y: 20 } }] });

  it("ignores date format, sub-pixel offsets and data the view does not draw", () => {
    const same = view({ r1: [{ task: "a", callout_offset: { x: 10.2, y: 19.8 } }] });
    same.tasks[0]!.start_date = "2026-04-01T00:00:00.000Z";
    same.view.selection = false;
    expect(sameDrawing(base, same)).toBe(true);
  });

  it("notices a moved entry, a changed task, another row order and another scale", () => {
    expect(sameDrawing(base, view({ r1: [{ task: "a", line: 0 }] }))).toBe(false);
    const renamed = view({ r1: [{ task: "a", callout_offset: { x: 10, y: 20 } }] });
    renamed.tasks[0]!.text = "Renamed";
    expect(sameDrawing(base, renamed)).toBe(false);
    expect(sameDrawing(view({ r1: [], r2: [] }), view({ r2: [], r1: [] }))).toBe(false);
    const rescaled = view({ r1: [{ task: "a", callout_offset: { x: 10, y: 20 } }] });
    rescaled.view.scale = "week";
    expect(sameDrawing(base, rescaled)).toBe(false);
  });
});

describe("view data to timeline", () => {
  it("reads the rows in their order", () => {
    expect(rowsFromView(view({ r2: [], r1: [] }))).toEqual([
      { id: "r2", name: "R2" },
      { id: "r1", name: "R1" },
    ]);
  });

  it("keeps an entry's id when it moves to a callout, storing the rounded position", () => {
    const moved = entriesFromView(
      view({ r1: [{ task: "a", callout_offset: { x: 10.4, y: 0.2 } }] }),
      [entry("e1", "a")],
      noPlans,
      newId,
    );
    expect(moved).toEqual([
      entry("e1", "a", { placement: "below", line: 0, calloutX: 10, calloutY: 1 }),
    ]);
  });

  it("reads a callout at or above the bar as above, and a bar without callout fields", () => {
    const [above] = entriesFromView(
      view({ r1: [{ task: "a", callout_offset: { x: 0, y: 0 } }] }),
      [entry("e1", "a", { placement: "below", calloutX: 1, calloutY: 2 })],
      noPlans,
      newId,
    );
    expect(above).toMatchObject({ placement: "above", calloutY: 0 });
    const [bar] = entriesFromView(
      view({ r1: [{ task: "a", line: 1 }] }),
      [entry("e1", "a", { placement: "below", calloutX: 1, calloutY: 2 })],
      noPlans,
      newId,
    );
    expect(bar).toEqual(entry("e1", "a", { line: 1 }));
  });

  it("follows an entry to another row without mixing it up with the same task's other entry", () => {
    const previous = [entry("e1", "a", { rowId: "r1" }), entry("e2", "a", { rowId: "r2" })];
    const moved = entriesFromView(
      view({ r2: [{ task: "a", line: 0 }], r3: [{ task: "a", line: 0 }] }),
      previous,
      noPlans,
      newId,
    );
    expect(moved.map((e) => [e.id, e.rowId])).toEqual([
      ["e2", "r2"],
      ["e1", "r3"],
    ]);
  });

  it("adds new entries with the dropped task's plan", () => {
    const added = entriesFromView(
      view({ r1: [{ task: "a", line: 0 }] }),
      [],
      new Map([["a", "plan-a"]]),
      newId,
    );
    expect(added).toEqual([entry("new", "a", { planId: "plan-a" })]);
  });

  it("drops removed entries but keeps those whose task the view could not show", () => {
    const kept = entriesFromView(
      view({ r1: [] }),
      [entry("e1", "a"), entry("hidden", "unreadable")],
      noPlans,
      newId,
    );
    expect(kept.map((e) => e.id)).toEqual(["hidden"]);
  });
});
