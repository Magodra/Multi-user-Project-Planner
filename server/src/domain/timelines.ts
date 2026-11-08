/** Timeline rules (CLAUDE.md §7 "Timelines"). Pure logic, no I/O. */
import type { TimelineEntry } from "@planning/shared";

/** Distance of the first numbered callout line from the bar, and between lines, in px. */
const CALLOUT_GAP = 16;
const CALLOUT_LINE_HEIGHT = 28;

/**
 * Entries stored before placement and lines existed are bars on the timeline,
 * spread over three lines per row in their order (as they used to be drawn).
 * Callouts stored before free positions existed get the position of their
 * numbered line. A callout's `calloutY` always matches its side of the bar;
 * bars have no callout position.
 */
export function normalizeTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const perRow = new Map<string, number>();
  return entries.map((e) => {
    const index = perRow.get(e.rowId) ?? 0;
    perRow.set(e.rowId, index + 1);
    const { calloutX, calloutY, ...entry } = e;
    const placement = e.placement ?? "on";
    const line = typeof e.line === "number" ? e.line : index % 3;
    if (placement === "on") return { ...entry, placement, line };
    const distance = CALLOUT_GAP + line * CALLOUT_LINE_HEIGHT;
    return {
      ...entry,
      placement,
      line,
      calloutX: calloutX ?? 0,
      calloutY:
        placement === "above"
          ? Math.min(0, calloutY ?? -distance)
          : Math.max(1, calloutY ?? distance),
    };
  });
}
