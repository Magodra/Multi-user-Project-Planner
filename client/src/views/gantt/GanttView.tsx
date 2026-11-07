/**
 * Gantt panel for one plan. Owns the GanttAdapter instance and keeps it in
 * sync with React state; never touches DHTMLX directly.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Baseline,
  type DependencyIssue,
  type PlanView,
  type Task,
  formatForDisplay,
  fromDisplayDate,
  toDisplayDate,
  varianceInDays,
} from "@planning/shared";
import { api } from "../../api/client";
import { itemBadges } from "../../components/status";
import { ErrorText } from "../../components/ui";
import { useLive, usePlanView, useProject, useProjectPlans } from "../../workspace/ProjectContext";
import { usePlanDropTarget, useWorkspaceActions } from "../../workspace/panels";
import {
  type GanttAdapter,
  type GanttCallbacks,
  type GanttLinkRow,
  type GanttRow,
  type OverlayBar,
  type ProposalBar,
  createGanttAdapter,
} from "./GanttAdapter";
import { ItemDialog } from "./ItemDialog";
import { describeDependencyIssue, lagText } from "./dependencyText";
import { planRows, recipientNames, referenceName, siblingsOf } from "./planRows";
import { ReferenceDialog } from "./ReferenceDialog";
import { predecessorText } from "./predecessors";
import {
  SCALE_UNITS,
  type ScaleUnit,
  type TimeScale,
  canZoom,
  defaultScale,
  fitScale,
  zoomScale,
} from "./scale";

/**
 * Rows in hierarchy order. References to external tasks sit among the local
 * tasks; their row id is the referenced task's id (as used by dependencies).
 * MONITOR references are read-only; AGREEMENT references can be dragged,
 * which proposes the change to the task's owner.
 */
function buildRows(view: PlanView, agreed: Baseline | null, canEdit: boolean): GanttRow[] {
  const agreedEnd = new Map((agreed?.items ?? []).map((i) => [i.itemId, i.end]));
  const pending = new Set(view.pendingItemIds);
  const variance = (id: string, end: string) => {
    const a = agreedEnd.get(id);
    return a ? varianceInDays(end, a) : null;
  };
  return planRows(view).map((row): GanttRow => {
    if (row.type === "task") {
      const t = row.task;
      const kind = view.kinds[t.id] ?? "task";
      return {
        id: t.id,
        text: t.name,
        parent: t.parentId,
        start: toDisplayDate(t.start, t.granularity),
        end: toDisplayDate(t.end, t.granularity),
        kind,
        number: String(t.taskNumber),
        predecessors: predecessorText(view, t.id),
        durationLabel: kind === "milestone" ? "◆" : `${t.duration} ${t.granularity}`,
        locked: !canEdit || kind === "activity",
        classes: [
          `pp-kind-${kind}`,
          t.ownership === "EXTERNAL" ? "pp-external" : "",
          t.agreementState === "REJECTED" ? "pp-rejected" : "",
          pending.has(t.id) ? "pp-pending" : "",
        ].filter(Boolean),
        badges: itemBadges({
          external: t.ownership === "EXTERNAL",
          recipients: recipientNames(view, t.id),
          reference: false,
          linkType: null,
          pending: pending.has(t.id),
          agreementState: t.agreementState,
          endVarianceDays: variance(t.id, t.end),
          dependencyIssues: issuesFor(view, t.id),
        }),
      };
    }
    const r = row.reference;
    const t = r.item;
    const kind = r.itemKind;
    return {
      id: t.id,
      text: referenceName(r),
      parent: r.parentId,
      start: toDisplayDate(t.start, t.granularity),
      end: toDisplayDate(t.end, t.granularity),
      kind,
      number: String(r.taskNumber),
      predecessors: predecessorText(view, t.id),
      durationLabel: kind === "milestone" ? "◆" : `${t.duration} ${t.granularity}`,
      // An activity's dates follow its subtasks in the owner plan; it cannot be dragged here.
      locked: !canEdit || r.linkType !== "AGREEMENT" || kind === "activity",
      classes: [
        "pp-reference",
        `pp-kind-${kind}`,
        r.linkType === "AGREEMENT" ? "pp-agreement-ref" : "",
        r.agreementState === "REJECTED" ? "pp-rejected" : "",
        pending.has(t.id) ? "pp-pending" : "",
      ].filter(Boolean),
      badges: itemBadges({
        external: true,
        recipients: [],
        reference: true,
        linkType: r.linkType,
        pending: pending.has(t.id),
        agreementState: r.agreementState,
        endVarianceDays: variance(t.id, t.end),
        dependencyIssues: issuesFor(view, t.id),
      }),
    };
  });
}

/** Names of all tasks shown in the plan (external ones with their owner plan). */
function taskNames(view: PlanView): Map<string, string> {
  return new Map([
    ...view.items.map((t) => [t.id, t.name] as const),
    ...view.references.map((r) => [r.item.id, referenceName(r)] as const),
  ]);
}

/** Explanation of one dependency problem in this plan. */
function dependencyIssueText(
  view: PlanView,
  issue: DependencyIssue,
  names: Map<string, string>,
): string {
  const dep = view.dependencies.find((d) => d.id === issue.dependencyId)!;
  return describeDependencyIssue({ ...issue, ...dep, fromName: names.get(dep.fromItemId) ?? "" });
}

/** Explanations of the dependencies a task does not respect. */
function issuesFor(view: PlanView, itemId: string): string[] {
  const names = taskNames(view);
  return view.dependencyIssues
    .filter((i) => view.dependencies.find((d) => d.id === i.dependencyId)?.toItemId === itemId)
    .map((i) => dependencyIssueText(view, i, names));
}

/** Pending proposals for external tasks, at the proposed dates. */
function buildProposals(view: PlanView, planNames: Map<string, string>): ProposalBar[] {
  return view.proposedChanges.map(({ proposed: p, planId, description }) => ({
    rowId: p.itemId,
    start: toDisplayDate(p.start, p.granularity),
    end: toDisplayDate(p.end, p.granularity),
    label:
      `Proposed by ${planNames.get(planId) ?? "another plan"}: ${p.name}, ` +
      `${formatForDisplay(p.start, p.granularity)}, ${p.duration} ${p.granularity}` +
      (description ? ` (${description})` : ""),
  }));
}

function buildOverlay(view: PlanView, baselines: Baseline[]): OverlayBar[] {
  const live = new Map<string, Task>([
    ...view.items.map((t) => [t.id, t] as const),
    ...view.references.map((r) => [r.item.id, r.item] as const),
  ]);
  return baselines.flatMap((b, slot) =>
    b.items
      .filter((i) => live.has(i.itemId))
      .map((i) => {
        const v = varianceInDays(live.get(i.itemId)!.end, i.end);
        return {
          rowId: i.itemId,
          start: toDisplayDate(i.start, i.granularity),
          end: toDisplayDate(i.end, i.granularity),
          slot,
          label: `${b.name}: ${i.start.slice(0, 10)} → ${i.end.slice(0, 10)}`,
          variance: v > 0 ? ("late" as const) : v < 0 ? ("early" as const) : ("same" as const),
        };
      }),
  );
}

export function GanttView({ planId }: { planId: string }) {
  const { data: view, error, reload } = usePlanView(planId);
  const { openPanel } = useWorkspaceActions();
  const drop = usePlanDropTarget("gantt", planId);
  const { project } = useProject();
  const plans = useProjectPlans(view?.plan.projectId ?? project.id);
  const [scale, setScale] = useState<TimeScale>(() => defaultScale("days"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlayIds, setOverlayIds] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<{ item: Task | null } | null>(null);
  const [referenceDialog, setReferenceDialog] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<GanttAdapter | null>(null);
  const viewRef = useRef<PlanView | null>(null);
  viewRef.current = view;

  const { data: allBaselines } = useLive(
    () => api.baselines.list(planId),
    (c) => c.planIds.includes(planId),
    [planId],
  );
  // Default overlay: Agreed and Current (the live bars are Estimated).
  const selectedIds = useMemo(
    () =>
      overlayIds ??
      [view?.trackBaselineIds.AGREED, view?.trackBaselineIds.CURRENT].filter((x): x is string =>
        Boolean(x),
      ),
    [overlayIds, view],
  );
  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => allBaselines?.find((b) => b.id === id))
        .filter((b): b is Baseline => Boolean(b)),
    [selectedIds, allBaselines],
  );
  const agreed = allBaselines?.find((b) => b.id === view?.trackBaselineIds.AGREED) ?? null;
  const canEdit =
    view?.myRoles.some((r) => r === "ADMIN" || r === "PLAN_OWNER" || r === "EDITOR") ?? false;

  useEffect(() => {
    const act = (fn: () => Promise<unknown>) =>
      fn()
        .then(() => setActionError(null))
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : String(err));
          void reload(); // put the bar back where the server has it
        });
    const findItem = (id: string) => viewRef.current?.items.find((t) => t.id === id);
    const findReference = (id: string) => viewRef.current?.references.find((r) => r.item.id === id);
    // Dragging an AGREEMENT reference proposes the change to the task's owner.
    const propose = (id: string, start: Date, end: Date | null) => {
      const ref = findReference(id);
      if (!ref) return;
      const g = ref.item.granularity;
      void act(() =>
        api.items.proposeTaskChange(ref.id, {
          start: fromDisplayDate(start, g),
          ...(end
            ? { end: fromDisplayDate(end, g) }
            : { duration: ref.item.duration, granularity: g }),
        }),
      ).then(() => void reload()); // the bar shows the owner's values until approved
    };
    const callbacks: GanttCallbacks = {
      onMove: (id, start) => {
        if (findReference(id)) return propose(id, start, null);
        const item = findItem(id);
        if (item)
          void act(() =>
            api.items.move(id, {
              version: item.version,
              start: fromDisplayDate(start, item.granularity),
            }),
          );
      },
      onResize: (id, start, end) => {
        if (findReference(id)) return propose(id, start, end);
        const item = findItem(id);
        if (item)
          void act(() =>
            api.items.update(id, {
              version: item.version,
              start: fromDisplayDate(start, item.granularity),
              end: fromDisplayDate(end, item.granularity),
            }),
          );
      },
      onOpen: (id) => {
        const item = findItem(id);
        if (item) setDialog({ item });
        const ref = findReference(id);
        if (ref) setReferenceDialog(ref.id);
      },
      onLinkCreate: (source, target, type) =>
        void act(() =>
          api.items.createDependency({
            fromItemId: source,
            toItemId: target,
            type,
            lag: 0,
            planId,
          }),
        ),
      onLinkDelete: (id) => {
        if (window.confirm("Delete this dependency?"))
          void act(() => api.items.deleteDependency(id));
      },
      onSelect: setSelectedId,
      onZoom: (direction) => setScale((s) => zoomScale(s, direction)),
    };
    const adapter = createGanttAdapter(callbacks);
    adapter.mount(containerRef.current!);
    adapterRef.current = adapter;
    return () => {
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [reload, planId]);

  useEffect(() => adapterRef.current?.setScale(scale), [scale]);
  useEffect(() => adapterRef.current?.setReadonly(!canEdit), [canEdit]);

  useEffect(() => {
    if (!view || !adapterRef.current) return;
    const issues = new Map(view.dependencyIssues.map((i) => [i.dependencyId, i]));
    const names = taskNames(view);
    const links: GanttLinkRow[] = view.dependencies.map((d) => ({
      id: d.id,
      source: d.fromItemId,
      target: d.toItemId,
      type: d.type,
      violated: issues.has(d.id),
      title: issues.has(d.id)
        ? dependencyIssueText(view, issues.get(d.id)!, names)
        : `${names.get(d.fromItemId) ?? ""} → ${names.get(d.toItemId) ?? ""} (${d.type}${lagText(d)})`,
    }));
    adapterRef.current.setData(buildRows(view, agreed, canEdit), links);
    adapterRef.current.setOverlay(buildOverlay(view, selected));
    adapterRef.current.setProposals(
      buildProposals(view, new Map(plans.map((p) => [p.id, p.name]))),
    );
  }, [view, agreed, selected, canEdit, plans]);

  // Tasks and references are reordered among their siblings (one shared order).
  const rows = useMemo(() => (view ? planRows(view) : []), [view]);
  const selectedRow =
    rows.find((r) =>
      r.type === "task" ? r.task.id === selectedId : r.reference.item.id === selectedId,
    ) ?? null;
  const reorder = (direction: "up" | "down") => {
    if (!selectedRow) return;
    const done =
      selectedRow.type === "task"
        ? api.items.reorder(selectedRow.task.id, { version: selectedRow.task.version, direction })
        : api.items.reorderReference(selectedRow.reference.id, {
            version: selectedRow.reference.version,
            direction,
          });
    done
      .then(() => setActionError(null))
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  };
  const siblings = selectedRow ? siblingsOf(rows, selectedRow) : [];
  const position = selectedRow ? siblings.indexOf(selectedRow) : -1;

  // Indent: subtask of the row above (an own task that is not a milestone). Outdent: one level up.
  const changeLevel = (direction: "indent" | "outdent") => {
    if (!selectedRow) return;
    const done =
      selectedRow.type === "task"
        ? api.items.changeLevel(selectedRow.task.id, {
            version: selectedRow.task.version,
            direction,
          })
        : api.items.changeReferenceLevel(selectedRow.reference.id, {
            version: selectedRow.reference.version,
            direction,
          });
    done
      .then(() => setActionError(null))
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  };
  const rowAbove = position > 0 ? siblings[position - 1] : undefined;
  const canIndent = rowAbove?.type === "task" && view?.kinds[rowAbove.task.id] !== "milestone";
  const canOutdent = (selectedRow?.depth ?? 0) > 0;

  // Deletes the selected task; an external task is only removed from this plan.
  const deleteSelected = () => {
    if (!selectedRow) return;
    const name =
      selectedRow.type === "task" ? selectedRow.task.name : referenceName(selectedRow.reference);
    const question =
      selectedRow.type === "task"
        ? `Delete task '${name}'?`
        : `Remove '${name}' from this plan? The task stays in its owner plan.`;
    if (!window.confirm(question)) return;
    const done =
      selectedRow.type === "task"
        ? api.items.delete(selectedRow.task.id, selectedRow.task.version)
        : api.items.removeReference(selectedRow.reference.id);
    done
      .then(() => setActionError(null))
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  };

  const fit = () => {
    const m = adapterRef.current?.measure();
    if (m) setScale(fitScale(m.spanDays, m.widthPx));
  };

  const toggleOverlay = (id: string) =>
    setOverlayIds((ids) => {
      const current = ids ?? selectedIds;
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-3);
    });

  return (
    <div
      ref={drop.setNodeRef}
      className={`pp-panel pp-gantt-panel${drop.isOver ? " pp-drop-over" : ""}`}
    >
      <div className="pp-toolbar">
        {canEdit && (
          <button type="button" className="pp-primary" onClick={() => setDialog({ item: null })}>
            + Task
          </button>
        )}
        {canEdit && (
          <span className="pp-button-group">
            <button
              type="button"
              aria-label="Move task up"
              title="Move the selected task up"
              disabled={position <= 0}
              onClick={() => reorder("up")}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Move task down"
              title="Move the selected task down"
              disabled={position < 0 || position >= siblings.length - 1}
              onClick={() => reorder("down")}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label="Outdent task"
              title="Outdent: move the selected task up one level"
              disabled={!canOutdent}
              onClick={() => changeLevel("outdent")}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Indent task"
              title="Indent: make the selected task a subtask of the task above"
              disabled={!canIndent}
              onClick={() => changeLevel("indent")}
            >
              →
            </button>
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            className="pp-danger"
            title={
              selectedRow?.type === "reference"
                ? "Remove the selected external task from this plan"
                : "Delete the selected task"
            }
            disabled={!selectedRow}
            onClick={deleteSelected}
          >
            {selectedRow?.type === "reference" ? "Remove" : "Delete"}
          </button>
        )}
        <label>
          Scale{" "}
          <select
            value={scale.unit}
            onChange={(e) => setScale(defaultScale(e.target.value as ScaleUnit))}
          >
            {SCALE_UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <span className="pp-button-group">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (Ctrl + wheel)"
            disabled={!canZoom(scale, -1)}
            onClick={() => setScale((s) => zoomScale(s, -1))}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (Ctrl + wheel)"
            disabled={!canZoom(scale, 1)}
            onClick={() => setScale((s) => zoomScale(s, 1))}
          >
            +
          </button>
          <button type="button" title="Fit the whole plan in view" onClick={fit}>
            Fit
          </button>
          <button
            type="button"
            title="Scroll to today"
            onClick={() => adapterRef.current?.scrollToToday()}
          >
            Today
          </button>
        </span>
        <details className="pp-menu">
          <summary>Baselines ({selected.length})</summary>
          <div className="pp-menu-body">
            {(allBaselines ?? []).map((b) => (
              <label key={b.id} className="pp-check">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(b.id)}
                  onChange={() => toggleOverlay(b.id)}
                />
                {b.name} {b.locked ? "🔒" : ""}
              </label>
            ))}
          </div>
        </details>
        <span className="pp-legend">
          {selected.map((b, i) => (
            <span key={b.id} className={`pp-legend-item pp-slot-${i}`}>
              {b.name}
            </span>
          ))}
        </span>
        <span className="pp-spacer" />
        <button
          type="button"
          onClick={() => view && openPanel("planItems", { planId }, `Tasks: ${view.plan.name}`)}
        >
          Task List
        </button>
        <button
          type="button"
          onClick={() => view && openPanel("baselines", { planId }, `Baselines: ${view.plan.name}`)}
        >
          Baselines & approvals
        </button>
      </div>
      <ErrorText error={error ?? actionError} />
      <div ref={containerRef} className="pp-gantt-host" />
      {dialog && view && (
        <ItemDialog view={view} item={dialog.item} onClose={() => setDialog(null)} />
      )}
      {referenceDialog && view && (
        <ReferenceDialog
          view={view}
          referenceId={referenceDialog}
          onClose={() => setReferenceDialog(null)}
        />
      )}
    </div>
  );
}
