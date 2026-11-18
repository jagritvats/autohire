"use client";

import { useEffect, useState, useCallback } from "react";

interface App {
  id: string;
  postingId: string;
  status: string;
  nextAction: string | null;
  nextActionAt: string | null;
  outcome: string | null;
  title: string;
  company: string;
  companyId: string | null;
  applyUrl: string | null;
  location: string;
}

const STATUSES = ["saved", "drafting", "ready", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "ghosted"];
const ACTIVE = new Set(["saved", "drafting", "ready", "applied", "screening", "interviewing", "offer"]);

export function ApplicationsView() {
  const [apps, setApps] = useState<App[]>([]);
  const load = useCallback(async () => {
    const res = await fetch("/api/applications", { cache: "no-store" });
    if (res.ok) setApps((await res.json()).applications);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    await fetch("/api/applications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    load();
  };

  const due = apps.filter((a) => a.nextActionAt && new Date(a.nextActionAt) <= new Date() && ACTIVE.has(a.status));
  const active = apps.filter((a) => ACTIVE.has(a.status));
  const closed = apps.filter((a) => !ACTIVE.has(a.status));

  const funnel = STATUSES.map((s) => ({ s, n: apps.filter((a) => a.status === s).length })).filter((x) => x.n > 0);

  return (
    <div className="crm">
      {apps.length === 0 && (
        <div className="empty-note" style={{ marginTop: 20 }}>
          No applications yet. Hit <strong>+ track</strong> on a match in the feed to start your pipeline.
        </div>
      )}

      {apps.length > 0 && (
        <div className="funnel">
          {funnel.map((f) => (
            <span className="funnel-stage" key={f.s}>
              <b>{f.n}</b> {f.s}
            </span>
          ))}
        </div>
      )}

      {due.length > 0 && (
        <section className="card-block danger" style={{ marginTop: 14 }}>
          <h2>⏰ Follow-ups due <span className="hint">({due.length})</span></h2>
          {due.map((a) => (
            <div className="crm-due" key={a.id}>
              <span>{a.title} · {a.company}</span>
              <span className="crm-due-act">{a.nextAction ?? "follow up"}</span>
            </div>
          ))}
        </section>
      )}

      {active.length > 0 && <Group title="Active" apps={active} patch={patch} />}
      {closed.length > 0 && <Group title="Closed" apps={closed} patch={patch} />}
    </div>
  );
}

async function fillLocal(postingId: string) {
  await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "form_fill", payload: { postingId } }),
  });
}

function Group({ title, apps, patch }: { title: string; apps: App[]; patch: (b: Record<string, unknown>) => void }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h2 className="crm-group">{title} <span className="hint">({apps.length})</span></h2>
      <div className="reg-table">
        <div className="crm-head">
          <span>role</span>
          <span>status</span>
          <span>next action</span>
          <span>due</span>
          <span></span>
        </div>
        {apps.map((a) => (
          <div className="crm-row" key={a.id}>
            <span className="crm-role">
              {a.companyId ? <a href={`/company/${a.companyId}`}>{a.company}</a> : a.company}
              <span className="crm-title">{a.title}</span>
            </span>
            <select value={a.status} onChange={(e) => patch({ id: a.id, status: e.target.value })}>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              className="crm-input"
              defaultValue={a.nextAction ?? ""}
              placeholder="e.g. send follow-up"
              onBlur={(e) => e.target.value !== (a.nextAction ?? "") && patch({ id: a.id, nextAction: e.target.value })}
            />
            <input
              className="crm-date"
              type="date"
              defaultValue={a.nextActionAt ? a.nextActionAt.slice(0, 10) : ""}
              onChange={(e) => patch({ id: a.id, nextActionAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            />
            <span className="crm-row-actions">
              <button className="fill-btn" title="pre-fill in your browser via the local agent (stops at review)" onClick={() => fillLocal(a.postingId)}>
                fill
              </button>
              {a.applyUrl && (
                <a className="cp-apply" href={a.applyUrl} target="_blank" rel="noreferrer">
                  open →
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
