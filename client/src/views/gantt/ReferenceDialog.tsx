/**
 * An external task used in this plan. Name, start, duration and unit come
 * from the owner's task. Its place in this plan's hierarchy is local. On a
 * MONITOR link the values are read-only; on an AGREEMENT link a change is
 * proposed to the task's owner and applied once approved.
 */
import { useState } from "react";
import {
  GRANULARITIES,
  type Granularity,
  type PlanView,
  formatForDisplay,
  parsePredecessors,
  fromDateInputValue,
  fromDateTimeInputValue,
  toDateInputValue,
  toDateTimeInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { Dialog, DialogTabs, ErrorText, Field, useAction } from "../../components/ui";
import { TaskApprovals } from "../approvals/TaskApprovals";
import { otherPlanPredecessors, predecessorText } from "./predecessors";
import { PredecessorsField } from "./PredecessorsField";
import { TASK_DIALOG_TABS, TaskAuditLog, type TaskDialogTab } from "./TaskAuditLog";

interface Props {
  view: PlanView;
  referenceId: string;
  onClose(): void;
}

export function ReferenceDialog({ view, referenceId, onClose }: Props) {
  const ref = view.references.find((r) => r.id === referenceId);
  const task = ref?.item;
  const canEdit = view.myRoles.some((r) => r === "ADMIN" || r === "PLAN_OWNER" || r === "EDITOR");
  const agreement = ref?.linkType === "AGREEMENT";
  const [name, setName] = useState(task?.name ?? "");
  const [start, setStart] = useState(task?.start ?? "");
  const [duration, setDuration] = useState(task?.duration ?? 0);
  const [granularity, setGranularity] = useState<Granularity>(task?.granularity ?? "days");
  const [parentId, setParentId] = useState<string | null>(ref?.parentId ?? null);
  const [description, setDescription] = useState("");
  // Links to this external task are local to the plan (its own task IDs).
  const initialPredecessors = task ? predecessorText(view, task.id) : "";
  const [predecessors, setPredecessors] = useState(initialPredecessors);
  const [tab, setTab] = useState<TaskDialogTab>("details");
  const { busy, error, run } = useAction();
  if (!ref || !task) return null;

  const editable = canEdit && agreement;
  // Managers of either plan may make the link an agreement (the server checks it).
  const canManage = view.myRoles.some((r) => r === "ADMIN" || r === "PLAN_OWNER");
  const upgrade = () => {
    if (
      !window.confirm(
        "Upgrade to AGREEMENT? Agreed values carry over. Afterwards, changes made here are proposed to the owner, and the owner's changes need this plan's approval when they are agreed.",
      )
    )
      return;
    void run(() => api.items.setReferenceType(ref.id, { type: "AGREEMENT" }));
  };
  const changed =
    name !== task.name ||
    start !== task.start ||
    duration !== task.duration ||
    granularity !== task.granularity;
  const pending = view.pendingItemIds.includes(task.id);
  const proposal = view.proposedChanges.find(
    (c) => c.planId === view.plan.id && c.proposed.itemId === task.id,
  );
  // Local tasks that can hold it: not milestones.
  const parents = view.items.filter((t) => view.kinds[t.id] !== "milestone");

  const save = () =>
    run(async () => {
      if (parentId !== ref.parentId)
        await api.items.moveReference(ref.id, { version: ref.version, parentId });
      if (predecessors.trim() !== initialPredecessors)
        await api.items.setPredecessors(task.id, { predecessors, planId: view.plan.id });
      if (editable && changed) {
        const scheduleChanged =
          start !== task.start || duration !== task.duration || granularity !== task.granularity;
        await api.items.proposeTaskChange(ref.id, {
          ...(name !== task.name && { name }),
          ...(scheduleChanged && { start, duration, granularity }),
          description,
        });
      }
    }).then((ok) => ok && onClose());

  const remove = () => run(() => api.items.removeReference(ref.id)).then((ok) => ok && onClose());

  const dateInput =
    granularity === "hours" ? (
      <input
        type="datetime-local"
        value={toDateTimeInputValue(start)}
        onChange={(e) => e.target.value && setStart(fromDateTimeInputValue(e.target.value))}
        disabled={!editable}
      />
    ) : (
      <input
        type="date"
        value={toDateInputValue(start)}
        onChange={(e) => e.target.value && setStart(fromDateInputValue(e.target.value))}
        disabled={!editable}
      />
    );

  return (
    <Dialog
      title={`External task ${ref.taskNumber} (from ${ref.ownerPlanName})`}
      onClose={onClose}
      footer={
        <>
          {canEdit && (
            <button
              type="button"
              className="pp-danger"
              onClick={() => void remove()}
              disabled={busy}
            >
              Remove from plan
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
              onClick={() => void save()}
              disabled={
                busy ||
                !name ||
                !parsePredecessors(predecessors).ok ||
                (!changed &&
                  parentId === ref.parentId &&
                  predecessors.trim() === initialPredecessors)
              }
            >
              {editable && changed ? "Propose change" : "Save"}
            </button>
          )}
        </>
      }
    >
      <DialogTabs<TaskDialogTab> tabs={TASK_DIALOG_TABS} selected={tab} onSelect={setTab} />
      {tab === "audit" && <TaskAuditLog itemId={task.id} granularity={task.granularity} />}
      <div hidden={tab !== "details"}>
        <p className="pp-hint">
          {agreement
            ? "AGREEMENT: changes are proposed to the task's owner and applied once approved."
            : "MONITOR: this task follows its owner plan and cannot be changed here."}
          {pending && " A change is waiting for approval."}
        </p>
        {!agreement && canManage && (
          <p>
            <button type="button" onClick={upgrade} disabled={busy}>
              Upgrade to AGREEMENT
            </button>
          </p>
        )}
        {proposal && (
          <p className="pp-hint pp-proposal-note">
            Proposed: {proposal.proposed.name},{" "}
            {formatForDisplay(proposal.proposed.start, proposal.proposed.granularity)},{" "}
            {proposal.proposed.duration} {proposal.proposed.granularity}
            {proposal.description && ` (${proposal.description})`}
          </p>
        )}
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
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
              disabled={!editable}
            />
          </Field>
          <Field label="Unit">
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              disabled={!editable}
            >
              {GRANULARITIES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        </div>
        {editable && changed && (
          <Field label="Reason for the change">
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        )}
        <PredecessorsField
          value={predecessors}
          onChange={setPredecessors}
          disabled={!canEdit}
          otherPlanLinks={otherPlanPredecessors(view, task.id)}
        />
        <Field label="Parent in this plan">
          <select
            value={parentId ?? ""}
            onChange={(e) => setParentId(e.target.value || null)}
            disabled={!canEdit}
          >
            <option value="">(top level)</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.taskNumber} {p.name}
              </option>
            ))}
          </select>
        </Field>
        <TaskApprovals itemId={task.id} />
      </div>
      <ErrorText error={error} />
    </Dialog>
  );
}
