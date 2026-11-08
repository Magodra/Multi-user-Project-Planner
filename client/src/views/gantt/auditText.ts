/** Plain-language text for the entries of a task's audit log. */
import {
  type AuditLogEntry,
  type Granularity,
  type TaskHistory,
  formatForDisplay,
} from "@planning/shared";

export interface AuditText {
  title: string;
  /** Values that changed or were proposed. */
  detail: string;
  /** What someone wrote: an approval comment or the reason for a request. */
  comment: string;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function changedValues(details: Record<string, unknown>, granularity: Granularity): string {
  const unit = typeof details.granularity === "string" ? details.granularity : null;
  const date = (value: unknown) =>
    typeof value === "string" ? formatForDisplay(value, (unit as Granularity) ?? granularity) : "";
  const parts: string[] = [];
  if (details.name !== undefined) parts.push(`Name: ${String(details.name)}`);
  if (details.start !== undefined) parts.push(`Start: ${date(details.start)}`);
  if (details.end !== undefined) parts.push(`End: ${date(details.end)}`);
  if (details.duration !== undefined)
    parts.push(`Duration: ${String(details.duration)}${unit ? ` ${unit}` : ""}`);
  if (details.ownership !== undefined) parts.push(`Ownership: ${String(details.ownership)}`);
  if (details.notes !== undefined) parts.push("Notes changed");
  if (details.parentId !== undefined) parts.push("Parent changed");
  return parts.join(" · ");
}

function requestText(entry: AuditLogEntry, history: TaskHistory, g: Granularity): AuditText {
  const request = history.requests[entry.entityId];
  const title = request?.title ?? "Change request";
  const labels: Record<string, string> = {
    create: `Requested: ${title}`,
    accept: `Accepted: ${title}`,
    reject: `Rejected: ${title}`,
    withdraw: `Withdrawn: ${title}`,
    supersede: `Replaced by a newer change: ${title}`,
  };
  const p = request?.proposed;
  return {
    title: labels[entry.action] ?? `${capitalize(entry.action)}: ${title}`,
    detail:
      entry.action === "create" && request
        ? [
            `From ${request.planName}`,
            ...(p
              ? [`${formatForDisplay(p.start, p.granularity ?? g)}, ${p.duration} ${p.granularity}`]
              : []),
          ].join(" · ")
        : "",
    comment: entry.action === "create" ? (request?.description ?? "") : "",
  };
}

function taskText(entry: AuditLogEntry, g: Granularity): AuditText {
  const { details, action } = entry;
  const labels: Record<string, string> = {
    create: "Created",
    move: "Moved",
    delete: "Deleted",
    update: details.changeRequestId ? "Approved change applied" : "Updated",
    reorder: `Moved ${String(details.direction ?? "")} among its siblings`,
    indent: "Indented",
    outdent: "Outdented",
  };
  return {
    title: labels[action] ?? capitalize(action),
    detail: changedValues(details, g),
    comment: "",
  };
}

/** Describe one audit entry for people reading the log. */
export function describeAuditEntry(
  entry: AuditLogEntry,
  history: TaskHistory,
  granularity: Granularity,
): AuditText {
  const plan = history.planNames[entry.entityId] ?? "";
  const { details, action } = entry;
  const plain = (title: string): AuditText => ({ title, detail: "", comment: "" });
  switch (entry.entityType) {
    case "task":
      return taskText(entry, granularity);
    case "changeRequest":
      return requestText(entry, history, granularity);
    case "approval":
      return {
        title: `${action === "approve" ? "Approved" : "Rejected"}${plan ? ` for ${plan}` : ""}`,
        detail: "",
        comment: typeof details.comment === "string" ? details.comment : "",
      };
    case "planItemReference":
      if (action === "create")
        return plain(
          `Used in ${plan || "another plan"}${details.linkType ? ` (${String(details.linkType)})` : ""}`,
        );
      if (action === "delete") return plain(`Removed from ${plan || "a plan"}`);
      return plain(`Moved in ${plan || "a plan"}`);
    case "planLink":
      return plain(
        action === "upgrade"
          ? "Link upgraded to AGREEMENT"
          : action === "downgrade"
            ? "Link downgraded to MONITOR"
            : `Link set to ${String(details.type ?? "")}`,
      );
    case "dependency":
      return plain(
        action === "delete"
          ? "Dependency removed"
          : action === "update"
            ? "Dependency changed"
            : "Dependency added",
      );
    default:
      return plain(`${capitalize(entry.entityType)}: ${action}`);
  }
}
