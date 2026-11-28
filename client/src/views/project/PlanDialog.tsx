/** Edit a plan's name, type and description, or delete it after confirmation. */
import { useEffect, useState } from "react";
import type { Plan, Role } from "@planning/shared";
import { api } from "../../api/client";
import { Dialog, ErrorText, Field, useAction } from "../../components/ui";

const MANAGE_ROLES: Role[] = ["ADMIN", "PLAN_OWNER"];

export function PlanDialog({
  plan,
  onClose,
  onChanged,
}: {
  plan: Plan;
  onClose(): void;
  /** After a save (`deleted` false) or a delete. */
  onChanged(deleted: boolean, name: string): void;
}) {
  const [name, setName] = useState(plan.name);
  const [planType, setPlanType] = useState(plan.planType);
  const [description, setDescription] = useState(plan.description);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const { busy, error, run } = useAction();

  // Only plan owners and admins may change a plan (the server enforces it too).
  useEffect(() => {
    api.plans.view(plan.id).then(
      (view) => setCanManage(view.myRoles.some((r) => MANAGE_ROLES.includes(r))),
      () => setCanManage(false),
    );
  }, [plan.id]);

  const save = () =>
    run(async () => {
      await api.plans.update(plan.id, { version: plan.version, name, planType, description });
      onChanged(false, name);
    });
  const remove = () => {
    if (
      !window.confirm(
        `Delete the plan '${plan.name}' with all its tasks, baselines and change requests? This cannot be undone.`,
      )
    )
      return;
    void run(async () => {
      await api.plans.delete(plan.id, plan.version);
      onChanged(true, plan.name);
    });
  };
  const disabled = !canManage || busy;

  return (
    <Dialog
      title="Edit plan"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pp-danger" onClick={remove} disabled={disabled}>
            Delete plan
          </button>
          <span className="pp-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pp-primary"
            onClick={() => void save()}
            disabled={disabled || !name || !planType}
          >
            Save
          </button>
        </>
      }
    >
      {canManage === false && (
        <p className="pp-hint">Only the plan's owners and project admins can change it.</p>
      )}
      <Field label="Name">
        <input
          name="planName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <Field label="Plan type">
        <input
          name="planType"
          value={planType}
          onChange={(e) => setPlanType(e.target.value)}
          disabled={!canManage}
          placeholder="contract, internal, …"
        />
      </Field>
      <Field label="Description">
        <textarea
          name="planDescription"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <ErrorText error={error} />
    </Dialog>
  );
}
