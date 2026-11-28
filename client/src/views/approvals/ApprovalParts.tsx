/** Pieces shared by the approval inbox and the task dialogs. Deciding is UI only (never MCP). */
import { useState } from "react";
import { type ChangeRequest, formatDateKey } from "@planning/shared";
import { api } from "../../api/client";

/** Badge text for a request: the target track, or "task change" for proposals. */
export function requestKindLabel(cr: ChangeRequest): string {
  return cr.kind === "PROPOSE_TASK_CHANGE" ? "task change" : cr.targetTrack.toLowerCase();
}

/** The values a request proposes, one row per task. */
export function ProposedTable({ cr }: { cr: ChangeRequest }) {
  return (
    <table className="pp-table">
      <thead>
        <tr>
          <th>Task</th>
          <th>Start</th>
          <th>End</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {cr.proposed.map((p) => (
          <tr key={p.itemId}>
            <td>{p.name}</td>
            <td>{formatDateKey(p.start)}</td>
            <td>{formatDateKey(p.end)}</td>
            <td>
              {p.duration} {p.granularity}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Comment plus Reject / Approve for one approval. */
export function DecisionControls({
  approvalId,
  busy,
  run,
  onDecided,
}: {
  approvalId: string;
  busy: boolean;
  run(fn: () => Promise<unknown>): Promise<boolean>;
  onDecided?(): void;
}) {
  const [comment, setComment] = useState("");
  const decide = (decision: "APPROVE" | "REJECT") =>
    void run(() => api.changeRequests.decide(approvalId, { decision, comment })).then(
      (ok) => ok && onDecided?.(),
    );
  return (
    <div className="pp-row pp-decision">
      <textarea
        name="decisionComment"
        rows={2}
        placeholder="Comment"
        aria-label="Comment"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <button type="button" className="pp-danger" disabled={busy} onClick={() => decide("REJECT")}>
        Reject
      </button>
      <button
        type="button"
        className="pp-primary"
        disabled={busy}
        onClick={() => decide("APPROVE")}
      >
        Approve
      </button>
    </div>
  );
}
