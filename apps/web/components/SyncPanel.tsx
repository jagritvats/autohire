"use client";

import { useState } from "react";
import type { SyncProgress } from "@jobflow/core";
import { ORIGIN_LABEL, TRIGGER_LABEL, cancelSync, duration, relTime, startSync, untilTime, useSyncStatus } from "@/lib/syncClient";
import { ActivityPanel } from "./ActivityPanel";
import { ProgressBar, RunBody, RunErrors, runFraction, runHeadline } from "./SyncDetails";
import { Badge, Banner, Button, type Tone } from "./ui";

/**
 * Sources → Sync: start or cancel a sync and watch it, then how each source did on the last
 * run and the recent runs — plus the maintenance tools (recheck, retire old, the job queue).
 * Live state comes from the shared sync watcher (the same one the header indicator uses).
 */
export function SyncPanel() {
  const { status } = useSyncStatus();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = status?.current ?? null;
  const last = status?.last ?? null;

  async function syncNow() {
    setBusy(true);
    setMsg(await startSync());
    setBusy(false);
  }
  async function cancel() {
    setBusy(true);
    setMsg(await cancelSync());
    setBusy(false);
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
    <section className="card-block sync-panel" id="sync" aria-labelledby="sync-title">
      <h2 id="sync-title">Sync</h2>
      <p className="hint">
        A sync fetches new jobs from your presets, your own sources and your saved searches, then re-ranks them for you.{" "}
        {status?.lastSyncAt ? `Last sync ${relTime(status.lastSyncAt)}.` : "Never synced yet."}{" "}
        {status?.nextSyncAt && !run ? `Next one ${untilTime(status.nextSyncAt)}.` : null}
      </p>
      <div className="field-row">
        {run ? (
          <Button variant="danger" icon="x" onClick={cancel} disabled={busy || run.cancelRequested || !status?.canSync}>
            {run.cancelRequested ? "Stopping…" : "Cancel sync"}
          </Button>
        ) : (
          <Button variant="primary" icon="refresh" onClick={syncNow} disabled={busy || !status || !status.canSync}>
            Sync now
          </Button>
        )}
        {status && !status.canSync && <span className="hint">Syncs on this shared instance run on a schedule.</span>}
      </div>

      {run && (
        <div className="sync-live" aria-label="Current sync">
          <p className="sync-drawer__lead">
            <b>{runHeadline(run)}</b>
          </p>
          <ProgressBar value={runFraction(run)} label="Sync progress" className="sync-bar--lg" />
          <RunBody run={run} />
        </div>
      )}
      {msg && (
        <Banner tone="info" live>
          {msg}
        </Banner>
      )}
      {!run && last && (
        <Banner tone={last.status === "done" && !last.errors.length ? "good" : last.status === "failed" ? "bad" : "warn"} title={`Last sync ${relTime(last.finishedAt)}`}>
          {last.message}
          {status?.you?.ranked && ` ${status.you.newMatches} new match${status.you.newMatches === 1 ? "" : "es"} for you.`}
        </Banner>
      )}
      {!run && last && <RunErrors run={last} />}

      <SourceTable run={run ?? last} />
      <RunHistory runs={status?.history ?? []} />

      <p className="hint">
        From the terminal: <code>jobflow sync</code> (quick) or <code>jobflow sync --full</code> (every board, slower).
      </p>
      <details style={{ marginTop: 12 }}>
        <summary className="hint">Maintenance and background jobs</summary>
        <div className="field-row" style={{ marginTop: 10 }}>
          <Button size="sm" onClick={recheck} title="Re-check every listed job against its board; closed ones are retired">
            recheck all jobs
          </Button>
          <Button size="sm" onClick={removeOld} title="Retire jobs their boards stopped listing a while ago">
            retire old jobs
          </Button>
        </div>
        <ActivityPanel />
      </details>
    </section>
  );
}

const SOURCE_TONE: Record<string, Tone> = { ok: "good", empty: "neutral", error: "bad", running: "info", skipped: "neutral" };
const KIND_LABEL: Record<string, string> = { feed: "feed", custom: "your source", search: "saved search", channel: "channel" };

/** how each source did on this run (the live one, else the last) */
function SourceTable({ run }: { run: SyncProgress | null }) {
  if (!run) return null;
  const rows = Object.entries(run.sources).sort(([, a], [, b]) => (a.status === "error" ? -1 : 0) - (b.status === "error" ? -1 : 0) || b.fetched - a.fetched);
  const b = run.boards;
  return (
    <div className="sync-table-wrap">
      <h3 className="sync-subtitle">{run.status === "running" ? "This sync, by source" : "Last sync, by source"}</h3>
      <table className="sync-table">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Fetched
            </th>
            <th scope="col" className="num">
              New
            </th>
            <th scope="col" className="num">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              Company job boards <span className="hint">({b.total} this run{b.notDue ? `, ${b.notDue} not due` : ""})</span>
            </th>
            <td>
              <Badge tone={b.failed && !b.done ? "bad" : b.failed ? "warn" : run.status === "running" ? "info" : "good"}>
                {run.status === "running" ? `${b.done + b.failed}/${b.total}` : b.failed ? `${b.failed} failed` : "ok"}
              </Badge>
            </td>
            <td className="num">{run.postings.fetched - rows.reduce((a, [, s]) => a + s.fetched, 0)}</td>
            <td className="num">{run.postings.new - rows.reduce((a, [, s]) => a + s.created, 0)}</td>
            <td className="num">{run.timing.avgBoardMs != null ? `${(run.timing.avgBoardMs / 1000).toFixed(1)} s each` : "—"}</td>
          </tr>
          {rows.map(([key, s]) => (
            <tr key={key}>
              <th scope="row">
                {s.label} <span className="hint">{KIND_LABEL[s.kind]}</span>
                {s.error && <div className="sync-table__err">{s.error}</div>}
              </th>
              <td>
                <Badge tone={SOURCE_TONE[s.status] ?? "neutral"}>{s.status === "empty" ? "nothing new" : s.status}</Badge>
              </td>
              <td className="num">{s.fetched}</td>
              <td className="num">{s.created}</td>
              <td className="num">{duration(s.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE: Record<SyncProgress["status"], Tone> = { done: "good", cancelled: "warn", failed: "bad", running: "info" };

/** the recent runs, newest first */
function RunHistory({ runs }: { runs: SyncProgress[] }) {
  if (!runs.length) return null;
  return (
    <div className="sync-table-wrap">
      <h3 className="sync-subtitle">Recent syncs</h3>
      <table className="sync-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Why</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Boards
            </th>
            <th scope="col" className="num">
              Fetched
            </th>
            <th scope="col" className="num">
              New
            </th>
            <th scope="col" className="num">
              Closed
            </th>
            <th scope="col" className="num">
              Took
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId}>
              <th scope="row" title={new Date(r.startedAt).toLocaleString()}>
                {relTime(r.startedAt)}
              </th>
              <td>
                {TRIGGER_LABEL[r.trigger]} <span className="hint">· {ORIGIN_LABEL[r.origin]}</span>
              </td>
              <td>
                <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                {r.errors.length > 0 && <span className="hint"> {r.errors.length} problem{r.errors.length === 1 ? "" : "s"}</span>}
              </td>
              <td className="num">
                {r.boards.done + r.boards.failed}/{r.boards.total}
              </td>
              <td className="num">{r.postings.fetched}</td>
              <td className="num">{r.postings.new}</td>
              <td className="num">{r.postings.gone + r.postings.expired}</td>
              <td className="num">{duration(r.timing.elapsedMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
