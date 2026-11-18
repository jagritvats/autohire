"use client";

import "../app/ux.css";
import { useCallback, useEffect, useState } from "react";
import { STATUS_LABEL } from "@/lib/cardText";

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
const TO_APPLY = new Set(["saved", "drafting", "ready"]);
const IN_PROGRESS = new Set(["applied", "screening", "interviewing", "offer"]);

/**
 * Applications — the tracker. Three groups follow the loop: to apply (saved → preparing →
 * ready), in progress (applied → offer), closed. Every row links back to its Job page, and
 * follow-ups that are due sit on top.
 */
export function ApplicationsView() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/applications", { cache: "no-store" });
    setApps(res.ok ? (await res.json()).applications : []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (body: Record<string, unknown>, msg: string) => {
    const r = await fetch("/api/applications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setNotice(r.ok ? msg : "Couldn't save that change.");
    setTimeout(() => setNotice(null), 4000);
    void load();
  };

  if (apps === null) return <p className="hint">Loading your applications…</p>;

  if (apps.length === 0)
    return (
      <div className="ux-empty">
        <h2>No applications yet</h2>
        When a job looks good, press <b>☆ save</b> on it — it lands here as <i>Saved</i>. From its job page you can tailor your résumé, open or
        pre-fill the form, and mark it applied; this page then keeps track of replies and follow-ups.
        <p>
          <a className="chip" href="/">
            Browse your jobs →
          </a>{" "}
          <a className="chip" href="/search">
            Search →
          </a>
        </p>
      </div>
    );

  const now = Date.now();
  const due = apps.filter((a) => a.nextActionAt && new Date(a.nextActionAt).getTime() <= now && (TO_APPLY.has(a.status) || IN_PROGRESS.has(a.status)));
  const toApply = apps.filter((a) => TO_APPLY.has(a.status));
  const inProgress = apps.filter((a) => IN_PROGRESS.has(a.status));
  const closed = apps.filter((a) => !TO_APPLY.has(a.status) && !IN_PROGRESS.has(a.status));
  const funnel = STATUSES.map((s) => ({ s, n: apps.filter((a) => a.status === s).length })).filter((x) => x.n > 0);

  return (
    <div className="crm">
      <div className="funnel" aria-label="By status">
        {funnel.map((f) => (
          <span className="funnel-stage" key={f.s}>
            <b>{f.n}</b> {STATUS_LABEL[f.s] ?? f.s}
          </span>
        ))}
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {due.length > 0 && (
        <section className="card-block danger" style={{ marginTop: 14 }}>
          <h3>Follow-ups due ({due.length})</h3>
          {due.map((a) => (
            <div className="crm-due" key={a.id}>
              <span>
                <a href={`/jobs/${a.postingId}`}>{a.title}</a> · {a.company}
              </span>
              <span className="crm-due-act">
                {a.nextAction ?? "follow up"} · due {new Date(a.nextActionAt!).toLocaleDateString()}{" "}
                <button type="button" className="chip" onClick={() => patch({ id: a.id, nextAction: null, nextActionAt: null }, `Done: ${a.nextAction ?? "follow-up"}.`)}>
                  done
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {toApply.length > 0 && <Group title="To apply" hint="saved, being prepared, or ready to send" apps={toApply} patch={patch} />}
      {inProgress.length > 0 && <Group title="In progress" hint="sent — waiting, screening, interviewing, offer" apps={inProgress} patch={patch} />}
      {closed.length > 0 && <Group title="Closed" hint="rejected, withdrawn or no response" apps={closed} patch={patch} />}
    </div>
  );
}

function Group({ title, hint, apps, patch }: { title: string; hint: string; apps: App[]; patch: (b: Record<string, unknown>, msg: string) => void }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h3 className="crm-group">
        {title} <span className="hint">({apps.length}) · {hint}</span>
      </h3>
      <div className="reg-table">
        <div className="crm-head">
          <span>job</span>
          <span>status</span>
          <span>next step</span>
          <span>by</span>
          <span></span>
        </div>
        {apps.map((a) => (
          <div className="crm-row" key={a.id}>
            <span className="crm-role">
              {a.companyId ? <a href={`/company/${a.companyId}`}>{a.company}</a> : a.company}
              <a className="crm-title" href={`/jobs/${a.postingId}`}>
                {a.title}
              </a>
            </span>
            <select aria-label={`Status of ${a.title}`} value={a.status} onChange={(e) => patch({ id: a.id, status: e.target.value }, `${a.title}: ${STATUS_LABEL[e.target.value] ?? e.target.value}.`)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <input
              className="crm-input"
              aria-label={`Next step for ${a.title}`}
              defaultValue={a.nextAction ?? ""}
              placeholder={TO_APPLY.has(a.status) ? "e.g. tailor the résumé" : "e.g. follow up with the recruiter"}
              onBlur={(e) => e.target.value !== (a.nextAction ?? "") && patch({ id: a.id, nextAction: e.target.value || null }, "Next step saved.")}
            />
            <input
              className="crm-date"
              type="date"
              aria-label={`Due date for ${a.title}`}
              defaultValue={a.nextActionAt ? a.nextActionAt.slice(0, 10) : ""}
              onChange={(e) => patch({ id: a.id, nextActionAt: e.target.value ? new Date(e.target.value).toISOString() : null }, e.target.value ? `Due ${e.target.value}.` : "Due date cleared.")}
            />
            <span className="crm-row-actions">
              {TO_APPLY.has(a.status) ? (
                <>
                  <a className="fill-btn" href={`/tailor/${a.postingId}`} title="Draft a résumé or cover letter for this job">
                    tailor
                  </a>
                  <a className="cp-apply" href={`/jobs/${a.postingId}#apply`} title="Checklist, open or pre-fill the form — you always submit">
                    apply →
                  </a>
                </>
              ) : (
                a.applyUrl && (
                  <a className="cp-apply" href={a.applyUrl} target="_blank" rel="noreferrer">
                    listing ↗
                  </a>
                )
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
