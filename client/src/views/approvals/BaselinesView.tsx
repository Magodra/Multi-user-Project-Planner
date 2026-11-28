/** Tracks, baseline tree (snapshots and branches), comparison and change requests of one plan. */
import { useState } from "react";
import { type BaselineTreeNode, type Track, formatDateKey } from "@planning/shared";
import { api } from "../../api/client";
import { Empty, ErrorText, useAction } from "../../components/ui";
import { useLive, usePlanView } from "../../workspace/ProjectContext";

function TreeNode({
  node,
  onLock,
  onBranch,
  onPromote,
  onDelete,
}: {
  node: BaselineTreeNode;
  onLock(id: string, version: number): void;
  onBranch(id: string): void;
  onPromote(id: string): void;
  onDelete(id: string): void;
}) {
  const b = node.baseline;
  return (
    <li>
      <div className="pp-tree-row">
        <span className={`pp-badge pp-b-${b.kind.toLowerCase()}`}>
          {b.kind === "TRACK" ? b.track?.toLowerCase() : b.kind.toLowerCase()}
        </span>
        <span>{b.name}</span>
        {b.locked && (
          <span title={`Locked ${b.lockedAt ? formatDateKey(b.lockedAt) : ""}`}>🔒</span>
        )}
        <span className="pp-spacer" />
        <button type="button" onClick={() => onBranch(b.id)}>
          Branch
        </button>
        {b.kind === "BRANCH" && !b.locked && (
          <>
            <button type="button" onClick={() => onPromote(b.id)}>
              Promote…
            </button>
            <button type="button" onClick={() => onLock(b.id, b.version)}>
              Lock
            </button>
            <button type="button" className="pp-danger" onClick={() => onDelete(b.id)}>
              Delete
            </button>
          </>
        )}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode
              key={c.baseline.id}
              node={c}
              onLock={onLock}
              onBranch={onBranch}
              onPromote={onPromote}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function BaselinesView({ planId }: { planId: string }) {
  const { data: view } = usePlanView(planId);
  const matches = (c: { planIds: string[] }) => c.planIds.includes(planId);
  const { data: tree, reload: reloadTree } = useLive(() => api.baselines.tree(planId), matches, [
    planId,
  ]);
  const { data: crs, reload: reloadCrs } = useLive(() => api.changeRequests.list(planId), matches, [
    planId,
  ]);
  const [compareWith, setCompareWith] = useState<string[]>(["CURRENT", "AGREED"]);
  const { data: comparison } = useLive(
    () => api.baselines.compare({ planId, against: compareWith }),
    matches,
    [planId, compareWith.join(",")],
  );
  const [snapshotName, setSnapshotName] = useState("");
  const { busy, error, run } = useAction();

  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      await Promise.all([reloadTree(), reloadCrs()]);
    });

  const request = (targetTrack: Track, sourceBaselineId: string | null = null) =>
    act(() =>
      api.changeRequests.create({
        planId,
        targetTrack,
        itemIds: [],
        sourceBaselineId,
        title: sourceBaselineId
          ? `Promote branch to ${targetTrack.toLowerCase()}`
          : `Accept plan into ${targetTrack.toLowerCase()}`,
        description: "",
      }),
    );

  const promote = (branchId: string) => {
    const target = window.prompt("Promote to ESTIMATED or CURRENT?", "ESTIMATED")?.toUpperCase();
    if (target === "ESTIMATED" || target === "CURRENT") void request(target, branchId);
  };

  const flat = (nodes: BaselineTreeNode[]): BaselineTreeNode["baseline"][] =>
    nodes.flatMap((n) => [n.baseline, ...flat(n.children)]);
  const compareOptions = [
    { key: "CURRENT", name: "Current" },
    { key: "AGREED", name: "Agreed" },
    ...flat(tree ?? [])
      .filter((b) => b.kind !== "TRACK")
      .map((b) => ({ key: b.id, name: b.name })),
  ];

  return (
    <div className="pp-panel pp-scroll">
      <ErrorText error={error} />
      <section>
        <h3>Acceptance</h3>
        <div className="pp-row">
          <button type="button" disabled={busy} onClick={() => request("CURRENT")}>
            Request whole plan: Estimated → Current
          </button>
        </div>
        <p className="pp-hint">
          Accept single tasks to Agreed from the task dialog (double-click a bar in the Gantt).
        </p>
      </section>

      <section>
        <h3>Baselines</h3>
        <div className="pp-row">
          <input
            name="snapshotName"
            placeholder="Snapshot name"
            value={snapshotName}
            onChange={(e) => setSnapshotName(e.target.value)}
          />
          <button
            type="button"
            disabled={!snapshotName || busy}
            onClick={() =>
              act(() =>
                api.baselines.create({
                  planId,
                  name: snapshotName,
                  kind: "SNAPSHOT",
                  fromBaselineId: null,
                  lock: true,
                }),
              ).then(() => setSnapshotName(""))
            }
          >
            Snapshot (locked)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(() =>
                api.baselines.create({
                  planId,
                  name: `What-if ${new Date().toLocaleDateString()}`,
                  kind: "BRANCH",
                  fromBaselineId: null,
                  lock: false,
                }),
              )
            }
          >
            Branch from live
          </button>
        </div>
        <ul className="pp-tree">
          {(tree ?? []).map((n) => (
            <TreeNode
              key={n.baseline.id}
              node={n}
              onLock={(id, version) => void act(() => api.baselines.lock(id, version))}
              onBranch={(id) =>
                void act(() =>
                  api.baselines.create({
                    planId,
                    name: `Branch of ${flat(tree ?? []).find((b) => b.id === id)?.name ?? ""}`,
                    kind: "BRANCH",
                    fromBaselineId: id,
                    lock: false,
                  }),
                )
              }
              onPromote={promote}
              onDelete={(id) =>
                window.confirm("Delete this branch?") && void act(() => api.baselines.delete(id))
              }
            />
          ))}
        </ul>
      </section>

      <section>
        <h3>Compare live plan</h3>
        <div className="pp-row">
          {compareOptions.map((o) => (
            <label key={o.key} className="pp-check">
              <input
                type="checkbox"
                name="compareWith"
                value={o.key}
                checked={compareWith.includes(o.key)}
                onChange={() =>
                  setCompareWith((c) =>
                    c.includes(o.key) ? c.filter((x) => x !== o.key) : [...c, o.key],
                  )
                }
              />
              {o.name}
            </label>
          ))}
        </div>
        {comparison && compareWith.length > 0 && (
          <table className="pp-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Live end</th>
                {comparison.columns.map((c) => (
                  <th key={c.key}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((r) => (
                <tr key={r.itemId}>
                  <td>{r.name}</td>
                  <td>{r.live ? formatDateKey(r.live.end) : "—"}</td>
                  {comparison.columns.map((c) => {
                    const v = r.endVarianceDays[c.key];
                    return (
                      <td
                        key={c.key}
                        className={v && v > 0 ? "pp-late" : v && v < 0 ? "pp-early" : ""}
                      >
                        {r.against[c.key]
                          ? `${formatDateKey(r.against[c.key]!.end)}${v ? ` (${v > 0 ? "+" : ""}${v}d)` : ""}`
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Change requests</h3>
        {crs?.length === 0 && <Empty>No change requests yet.</Empty>}
        <table className="pp-table">
          <tbody>
            {crs?.map(({ changeRequest: cr, approvals }) => (
              <tr key={cr.id}>
                <td>{cr.title}</td>
                <td>
                  <span className={`pp-badge pp-cr-${cr.status.toLowerCase()}`}>
                    {cr.status.toLowerCase()}
                  </span>
                </td>
                <td>
                  {approvals
                    .map((a) =>
                      a.status === "APPROVED" ? "✓" : a.status === "REJECTED" ? "✗" : "…",
                    )
                    .join(" ")}
                </td>
                <td>{formatDateKey(cr.createdAt)}</td>
                <td>
                  {cr.status === "PENDING" && (
                    <button
                      type="button"
                      onClick={() => act(() => api.changeRequests.withdraw(cr.id))}
                    >
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {view && (
        <p className="pp-hint">
          Your roles on {view.plan.name}: {view.myRoles.join(", ") || "none"}
        </p>
      )}
    </div>
  );
}
