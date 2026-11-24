/** Saved report definitions: choose content, run repeatedly, export HTML/PDF/CSV. */
import { useState } from "react";
import {
  type Baseline,
  type ReportDefinition,
  type ReportFormat,
  GRANULARITIES,
  type Granularity,
  fromDateInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { Empty, ErrorText, Field, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function NewReportForm({ onCreated }: { onCreated(): void }) {
  const { project, plans } = useProject();
  const { data: timelines } = useLive(
    () => api.timelines.list(project.id),
    (c) => c.entityType === "timeline",
    [project.id],
  );
  const [name, setName] = useState("");
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [timelineIds, setTimelineIds] = useState<string[]>([]);
  const [baselineIds, setBaselineIds] = useState<string[]>([]);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [granularity, setGranularity] = useState<Granularity>("days");
  const [nameContains, setNameContains] = useState("");
  const { busy, error, run } = useAction();

  const togglePlan = async (id: string) => {
    const next = planIds.includes(id) ? planIds.filter((x) => x !== id) : [...planIds, id];
    setPlanIds(next);
    setBaselines((await Promise.all(next.map((p) => api.baselines.list(p)))).flat());
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <form
      className="pp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          api.reports.create(project.id, {
            name,
            planIds,
            timelineIds,
            baselineIds,
            rangeStart: rangeStart ? fromDateInputValue(rangeStart) : null,
            rangeEnd: rangeEnd ? fromDateInputValue(rangeEnd) : null,
            granularity,
            filter: nameContains ? { nameContains } : {},
          }),
        ).then((ok) => ok && onCreated());
      }}
    >
      <Field label="Report name">
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <fieldset>
        <legend>Plans</legend>
        {plans.map((p) => (
          <label key={p.id} className="pp-check">
            <input
              type="checkbox"
              checked={planIds.includes(p.id)}
              onChange={() => void togglePlan(p.id)}
            />
            {p.name}
          </label>
        ))}
      </fieldset>
      {baselines.length > 0 && (
        <fieldset>
          <legend>Compare with baselines</legend>
          {baselines.map((b) => (
            <label key={b.id} className="pp-check">
              <input
                type="checkbox"
                checked={baselineIds.includes(b.id)}
                onChange={() => toggle(baselineIds, setBaselineIds, b.id)}
              />
              {plans.find((p) => p.id === b.planId)?.name}: {b.name}
            </label>
          ))}
        </fieldset>
      )}
      {(timelines?.length ?? 0) > 0 && (
        <fieldset>
          <legend>Timelines</legend>
          {timelines!.map((t) => (
            <label key={t.id} className="pp-check">
              <input
                type="checkbox"
                checked={timelineIds.includes(t.id)}
                onChange={() => toggle(timelineIds, setTimelineIds, t.id)}
              />
              {t.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="pp-row">
        <Field label="From">
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
        </Field>
        <Field label="Granularity">
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
          >
            {GRANULARITIES.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Name contains">
          <input value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
        </Field>
      </div>
      <ErrorText error={error} />
      <button type="submit" className="pp-primary" disabled={busy || !name || planIds.length === 0}>
        Save report
      </button>
    </form>
  );
}

export function ReportsView() {
  const { project } = useProject();
  const { data: reports, reload } = useLive(
    () => api.reports.list(project.id),
    () => false,
    [project.id],
  );
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const runReport = (def: ReportDefinition, format: ReportFormat) =>
    run(async () => {
      const blob = await api.reports.run(def.id, { format, asOfBaselineId: null });
      if (format === "html") setPreview(await blob.text());
      else download(blob, `${def.name}.${format}`);
    });

  return (
    <div className="pp-panel pp-scroll">
      <div className="pp-toolbar">
        <button type="button" className="pp-primary" onClick={() => setCreating((c) => !c)}>
          {creating ? "Close" : "+ Report"}
        </button>
      </div>
      {creating && (
        <NewReportForm
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
      <ErrorText error={error} />
      {reports?.length === 0 && !creating && <Empty>No reports yet.</Empty>}
      <ul className="pp-cards">
        {reports?.map((r) => (
          <li key={r.id} className="pp-card">
            <header>
              <strong>{r.name}</strong>
            </header>
            <div className="pp-row">
              <button type="button" disabled={busy} onClick={() => runReport(r, "html")}>
                Preview
              </button>
              <button type="button" disabled={busy} onClick={() => runReport(r, "pdf")}>
                PDF
              </button>
              <button type="button" disabled={busy} onClick={() => runReport(r, "csv")}>
                CSV
              </button>
              <span className="pp-spacer" />
              <button
                type="button"
                className="pp-danger"
                onClick={() =>
                  window.confirm(`Delete report '${r.name}'?`) &&
                  void run(() => api.reports.delete(r.id)).then(reload)
                }
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {preview && (
        <iframe className="pp-report-preview" title="Report preview" sandbox="" srcDoc={preview} />
      )}
    </div>
  );
}
