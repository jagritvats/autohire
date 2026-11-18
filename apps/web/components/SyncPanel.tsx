"use client";

import { useEffect, useState } from "react";
import type { SetupProgress } from "@jobflow/service";
import { ActivityPanel } from "./ActivityPanel";

/**
 * Sync — fetch new jobs from every source above, then re-rank — with progress, plus the
 * maintenance tools that used to crowd the Jobs page (recheck, remove old, the job queue).
 */
export function SyncPanel({ initial }: { initial: SetupProgress }) {
  const [p, setP] = useState(initial);
  const [syncing, setSyncing] = useState(initial.corpus.syncing);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(async () => {
      const next = (await fetch("/api/progress", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as SetupProgress | null;
      if (!next) return;
      setP(next);
      if (!next.corpus.syncing) {
        setSyncing(false);
        setMsg(next.corpus.postings ? `Done — ${next.corpus.postings} jobs in your list.` : "Done, but no jobs came back. The boards may be unreachable from this machine.");
      }
    }, 3000);
    return () => clearInterval(t);
  }, [syncing]);

  async function syncNow() {
    setMsg(null);
    const r = await fetch("/api/refresh?background=1", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg(d.error ?? "Couldn't start a sync.");
    setSyncing(true);
  }

  async function recheck() {
    const r = await fetch("/api/postings/recheck", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    setMsg(r.ok ? "Recheck queued — progress shows in the activity list below." : "Couldn't queue a recheck.");
  }

  async function removeOld() {
    const raw = window.prompt("Retire jobs not seen on their board for how many days?", "30");
    const days = Number(raw);
    if (!raw || !Number.isFinite(days) || days <= 0) return;
    const r = await fetch("/api/postings/purge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ olderThanDays: days, field: "lastSeen" }) });
    setMsg(r.ok ? `Queued: retire jobs not seen for ${days} days.` : "Couldn't queue that.");
  }

  return (
    <section className="card-block" id="sync">
      <h3>Sync</h3>
      <p className="hint">
        A sync fetches new jobs from your presets, your own sources and your saved searches, then re-ranks them for you.{" "}
        {p.corpus.lastSyncAt ? `Last sync: ${new Date(p.corpus.lastSyncAt).toLocaleString()}.` : "Never synced yet."} {p.corpus.postings} jobs in your list.
      </p>
      <div className="field-row" style={{ alignItems: "center" }}>
        <button type="button" className="save" onClick={syncNow} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        {syncing && <span className="hint" role="status">Fetching — this takes a minute or two. You can leave this page.</span>}
        {msg && !syncing && (
          <span className="hint" role="status">
            {msg} {p.corpus.postings > 0 && <a href="/">See your jobs →</a>}
          </span>
        )}
      </div>
      <p className="hint">
        From the terminal: <code>jobflow sync</code> (quick) or <code>jobflow sync --full</code> (every board, slower).
      </p>
      <details style={{ marginTop: 12 }}>
        <summary className="hint">Maintenance and background jobs</summary>
        <div className="field-row" style={{ marginTop: 10 }}>
          <button type="button" className="cmd" onClick={recheck} title="Re-check every listed job against its board; closed ones are retired">
            recheck all jobs
          </button>
          <button type="button" className="cmd" onClick={removeOld} title="Retire jobs their boards stopped listing a while ago">
            retire old jobs
          </button>
        </div>
        <ActivityPanel />
      </details>
    </section>
  );
}
