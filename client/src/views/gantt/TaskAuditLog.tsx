/** "Audit log" tab of the task dialogs: everything recorded about one task, newest first. */
import { type Granularity, formatForDisplay } from "@planning/shared";
import { api } from "../../api/client";
import { Badge, ErrorText } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { describeAuditEntry } from "./auditText";

export type TaskDialogTab = "details" | "audit";

export const TASK_DIALOG_TABS: { id: TaskDialogTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "audit", label: "Audit log" },
];

export function TaskAuditLog({
  itemId,
  granularity,
}: {
  itemId: string;
  granularity: Granularity;
}) {
  const { users } = useProject();
  const { data, error } = useLive(
    () => api.changeRequests.history(itemId),
    () => true,
    [itemId],
  );
  if (!data) return <ErrorText error={error} />;
  if (data.entries.length === 0) return <p className="pp-hint">Nothing recorded yet.</p>;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  return (
    <ol className="pp-audit-log" data-testid="task-audit-log">
      {[...data.entries].reverse().map((entry) => {
        const { title, detail, comment } = describeAuditEntry(entry, data, granularity);
        return (
          <li key={entry.id}>
            <strong>{title}</strong>{" "}
            {entry.origin === "MCP" && (
              <Badge className="pp-b-ref" title="Made by an AI assistant via MCP">
                MCP
              </Badge>
            )}
            <div className="pp-hint">
              {formatForDisplay(entry.createdAt, "hours")} · {nameOf(entry.createdBy)}
            </div>
            {detail && <div>{detail}</div>}
            {comment && <blockquote>{comment}</blockquote>}
          </li>
        );
      })}
    </ol>
  );
}
