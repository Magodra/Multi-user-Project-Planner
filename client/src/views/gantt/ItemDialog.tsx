import { useState } from "react";
import {
  GRANULARITIES,
  type Granularity,
  type PlanView,
  type Task,
  fromDateInputValue,
  fromDateTimeInputValue,
  nowIso,
  parsePredecessors,
  startOfUnit,
  toDateInputValue,
  toDateTimeInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { Dialog, DialogTabs, ErrorText, Field, useAction } from "../../components/ui";
import { otherPlanPredecessors, predecessorText } from "./predecessors";
import { PredecessorsField } from "./PredecessorsField";
import { TaskApprovals } from "../approvals/TaskApprovals";
import { TASK_DIALOG_TABS, TaskAuditLog, type TaskDialogTab } from "./TaskAuditLog";
import { UsedInSection } from "./UsedInSection";

interface Props {
  view: PlanView;
  /** Existing item to edit, or null to create. */
  item: Task | null;
  defaultParentId?: string | null;
  onClose(): void;
}

/** Create/edit a plan item, plus its acceptance and sharing actions. */
export function ItemDialog({ view, item, defaultParentId = null, onClose }: Props) {
  const canEdit = view.myRoles.some((r) => r === "ADMIN" || r === "PLAN_OWNER" || r === "EDITOR");
  const kind = item ? view.kinds[item.id] : "task";
  const [name, setName] = useState(item?.name ?? "");
  const [granularity, setGranularity] = useState<Granularity>(item?.granularity ?? "days");
  const [start, setStart] = useState(item?.start ?? startOfUnit(nowIso(), "days"));
  const [duration, setDuration] = useState(item?.duration ?? 5);
  const [ownership, setOwnership] = useState(item?.ownership ?? "INTERNAL");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [parentId, setParentId] = useState<string | null>(item ? item.parentId : defaultParentId);
  const initialPredecessors = item ? predecessorText(view, item.id) : "";
  const [predecessors, setPredecessors] = useState(initialPredecessors);
  const parsedPredecessors = parsePredecessors(predecessors);
  const [reason, setReason] = useState("");
  const [tab, setTab] = useState<TaskDialogTab>("details");
  const { busy, error, run } = useAction();

  const parents = view.items.filter((t) => t.id !== item?.id && view.kinds[t.id] !== "milestone");
  const usedIn = item ? (view.recipients[item.id] ?? []) : [];
  // Other plans have to approve a new schedule for a task they use under AGREEMENT.
  const approvers = usedIn.filter((r) => r.linkType === "AGREEMENT");
  const scheduleChanged =
    item !== null &&
    kind !== "activity" &&
    (start !== item.start || duration !== item.duration || granularity !== item.granularity);
  const proposes = scheduleChanged && approvers.length > 0;

  const save = () =>
    run(async () => {
      let taskId = item?.id;
      if (item) {
        await api.items.update(item.id, {
          version: item.version,
          name,
          notes,
          ownership,
          ...(kind !== "activity" ? { start, duration, granularity } : {}),
          ...(proposes && { reason }),
        });
        if (parentId !== item.parentId) {
          const fresh = (await api.plans.view(view.plan.id)).items.find((t) => t.id === item.id)!;
          await api.items.move(item.id, { version: fresh.version, parentId });
        }
      } else {
        taskId = (
          await api.items.create({
            planId: view.plan.id,
            parentId,
            name,
            start,
            duration,
            granularity,
            notes,
            ownership,
          })
        ).id;
      }
      if (taskId && predecessors.trim() !== initialPredecessors)
        await api.items.setPredecessors(taskId, { predecessors, planId: view.plan.id });
    }).then((ok) => ok && onClose());

  const remove = () =>
    item && run(() => api.items.delete(item.id, item.version)).then((ok) => ok && onClose());

  const request = (targetTrack: "CURRENT" | "AGREED") =>
    item &&
    run(() =>
      api.changeRequests.create({
        planId: view.plan.id,
        targetTrack,
        itemIds: [item.id],
        sourceBaselineId: null,
        title: `${targetTrack === "CURRENT" ? "Accept" : "Agree"}: ${item.name}`,
        description: "",
      }),
    ).then((ok) => ok && onClose());

  const dateInput =
    granularity === "hours" ? (
      <input
        type="datetime-local"
        value={toDateTimeInputValue(start)}
        onChange={(e) => e.target.value && setStart(fromDateTimeInputValue(e.target.value))}
        disabled={!canEdit || kind === "activity"}
      />
    ) : (
      <input
        type="date"
        value={toDateInputValue(start)}
        onChange={(e) => e.target.value && setStart(fromDateInputValue(e.target.value))}
        disabled={!canEdit || kind === "activity"}
      />
    );

  return (
    <Dialog
      title={item ? `Edit ${kind} ${item.taskNumber}` : "New task"}
      onClose={onClose}
      footer={
        <>
          {item && canEdit && (
            <button type="button" className="pp-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <span className="pp-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {canEdit && (
            <button
              type="button"
              className="pp-primary"
              onClick={save}
              disabled={busy || !name || !parsedPredecessors.ok}
            >
              {proposes ? "Propose change" : "Save"}
            </button>
          )}
        </>
      }
    >
      {item && (
        <DialogTabs<TaskDialogTab> tabs={TASK_DIALOG_TABS} selected={tab} onSelect={setTab} />
      )}
      {item && tab === "audit" && <TaskAuditLog itemId={item.id} granularity={item.granularity} />}
      {/* Hidden, not removed: unsaved edits stay when looking at the audit log. */}
      <div hidden={tab !== "details"}>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            autoFocus
          />
        </Field>
        <div className="pp-row">
          <Field label={granularity === "hours" ? "Start (UTC)" : "Start"}>{dateInput}</Field>
          <Field label="Duration">
            <input
              type="number"
              min={0}
              step={granularity === "hours" ? 0.5 : 1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              disabled={!canEdit || kind === "activity"}
            />
          </Field>
          <Field label="Unit">
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              disabled={!canEdit || kind === "activity"}
            >
              {GRANULARITIES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        </div>
        <PredecessorsField
          value={predecessors}
          onChange={setPredecessors}
          disabled={!canEdit}
          otherPlanLinks={item ? otherPlanPredecessors(view, item.id) : []}
        />
        {kind === "activity" && <p className="pp-hint">Activity dates follow its subtasks.</p>}
        {proposes && (
          <>
            <p className="pp-hint pp-proposal-note">
              This task is used under AGREEMENT. The new dates apply once{" "}
              {approvers.map((r) => r.planName).join(", ")} approve.
            </p>
            <Field label="Reason for the change">
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
        {duration === 0 && kind !== "activity" && (
          <p className="pp-hint">Duration 0 makes this a milestone.</p>
        )}
        <div className="pp-row">
          <Field label="Parent">
            <select
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value || null)}
              disabled={!canEdit}
            >
              <option value="">(top level)</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ownership">
            <select
              value={ownership}
              onChange={(e) => setOwnership(e.target.value as Task["ownership"])}
              disabled={!canEdit || usedIn.length > 0}
            >
              <option value="INTERNAL">Internal (this plan only)</option>
              <option value="EXTERNAL">External (can be used in other plans)</option>
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={!canEdit}
          />
        </Field>

        {item && (
          <section className="pp-dialog-section">
            <h3>Acceptance</h3>
            <div className="pp-row">
              <button type="button" onClick={() => request("CURRENT")} disabled={busy}>
                Request: Estimated → Current
              </button>
              <button type="button" onClick={() => request("AGREED")} disabled={busy}>
                Request: Current → Agreed
              </button>
            </div>
            <p className="pp-hint">State: {item.agreementState.toLowerCase()}.</p>
          </section>
        )}

        {item && <TaskApprovals itemId={item.id} />}
        {item && item.ownership === "EXTERNAL" && <UsedInSection view={view} task={item} />}
      </div>
      <ErrorText error={error} />
    </Dialog>
  );
}
