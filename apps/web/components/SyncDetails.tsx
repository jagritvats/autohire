"use client";

import { SYNC_PHASE_LABEL, type SyncProgress } from "@jobflow/core";
import { Badge, Icon, cx } from "./ui";
import { duration, etaText } from "@/lib/syncClient";

/**
 * The pieces of a sync's progress, rendered from the one SyncProgress model: the overall
 * bar, the phase stepper, the board/feed bars, what's in flight, the counts and the errors.
 * Used by the header's sync panel; the Sources page reuses the summary parts.
 */

/** 0..1 across the whole run (mirrors service `syncFraction`) */
export function runFraction(s: SyncProgress): number {
  if (s.status !== "running") return 1;
  const w: Record<string, number> = { renormalize: 0.03, discover: 0.04, boards: 0.65, feeds: 0.15, resolve: 0.04, expire: 0.03, process: 0.03, rank: 0.05 };
  let f = 0;
  for (const p of s.phases) {
    const weight = w[p.id] ?? 0;
    if (p.status === "done" || p.status === "skipped") f += weight;
    else if (p.status === "active") {
      if (p.id === "boards" && s.boards.total) f += (weight * (s.boards.done + s.boards.failed + s.boards.skipped)) / s.boards.total;
      else if (p.id === "feeds" && s.feeds.total) f += (weight * (s.feeds.done + s.feeds.failed)) / s.feeds.total;
    }
  }
  return Math.min(0.99, Math.max(0, f));
}

/** what the run is doing, in a few words: "Checking job boards · 38/232" */
export function runHeadline(s: SyncProgress): string {
  if (s.cancelRequested && s.status === "running") return "Stopping after the boards in flight…";
  if (!s.phase) return s.status === "running" ? "Starting…" : "Finished";
  const label = SYNC_PHASE_LABEL[s.phase];
  if (s.phase === "boards" && s.boards.total) return `${label} · ${s.boards.done + s.boards.failed}/${s.boards.total}`;
  if (s.phase === "feeds" && s.feeds.total) return `${label} · ${s.feeds.done + s.feeds.failed}/${s.feeds.total}`;
  return label;
}

export function ProgressBar({ value, label, tone, className }: { value: number; label: string; tone?: "good" | "warn" | "bad"; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cx("sync-bar", tone && `sync-bar--${tone}`, className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="sync-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** a small determinate ring for the header (decorative: the text beside it says the same) */
export function ProgressRing({ value, size = 18 }: { value: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="sync-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="sync-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth="2.5" fill="none" />
      <circle
        className="sync-ring__fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth="2.5"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0.04, Math.min(1, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="round"
      />
    </svg>
  );
}

const PHASE_ICON = { done: "check", active: "refresh", skipped: "dot", pending: "dot" } as const;

export function PhaseStepper({ run }: { run: SyncProgress }) {
  return (
    <ol className="sync-steps" aria-label="Sync steps">
      {run.phases.map((p) => {
        const ms = p.startedAt != null && p.finishedAt != null ? p.finishedAt - p.startedAt : null;
        const state = p.status === "skipped" ? "skipped" : p.status === "done" ? "done" : p.status === "active" ? "now" : "next";
        return (
          <li key={p.id} className="sync-step" data-state={p.status} aria-current={p.status === "active" ? "step" : undefined}>
            <span className="sync-step__mark">
              <Icon name={PHASE_ICON[p.status]} size={12} />
            </span>
            <span className="sync-step__label">{SYNC_PHASE_LABEL[p.id]}</span>
            <span className="sync-step__meta">
              {p.status !== "skipped" && <span className="sr-only">{state}</span>}
              {p.status === "done" && ms != null && ms >= 1000 ? duration(ms) : p.status === "skipped" ? "skipped" : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RunCounts({ run }: { run: SyncProgress }) {
  const p = run.postings;
  return (
    <dl className="sync-counts">
      <div>
        <dt>fetched</dt>
        <dd>{p.fetched}</dd>
      </div>
      <div>
        <dt>new</dt>
        <dd>{p.new}</dd>
      </div>
      <div>
        <dt>updated</dt>
        <dd>{p.updated}</dd>
      </div>
      <div>
        <dt>closed</dt>
        <dd>{p.gone + p.expired}</dd>
      </div>
    </dl>
  );
}

/** boards + feeds bars, what's in flight, timing */
export function RunBody({ run }: { run: SyncProgress }) {
  const b = run.boards;
  const settled = b.done + b.failed + b.skipped;
  const f = run.feeds;
  const eta = etaText(run.timing.etaMs);
  return (
    <div className="sync-body">
      <div className="sync-row">
        <div className="sync-row__head">
          <span>Job boards</span>
          <span className="num">
            {b.done + b.failed}/{b.total}
          </span>
        </div>
        <ProgressBar value={b.total ? settled / b.total : run.status === "running" ? 0 : 1} label="Job boards checked" tone={b.failed > b.done && b.failed > 0 ? "warn" : undefined} />
        <p className="sync-row__note">
          {[
            b.failed ? `${b.failed} didn't answer` : null,
            b.skipped ? `${b.skipped} left for later (time limit${run.cancelRequested ? " or cancel" : ""})` : null,
            b.deferred ? `${b.deferred} more due next sync` : null,
            b.notDue ? `${b.notDue} not due yet` : null,
          ]
            .filter(Boolean)
            .join(" · ") || (b.total ? "every board answered" : run.status === "running" ? "planning…" : "no boards were due")}
        </p>
      </div>
      {(f.total > 0 || run.status === "running") && (
        <div className="sync-row">
          <div className="sync-row__head">
            <span>Feeds, your sources and saved searches</span>
            <span className="num">
              {f.done + f.failed}/{f.total || "–"}
            </span>
          </div>
          <ProgressBar value={f.total ? (f.done + f.failed) / f.total : 0} label="Feeds read" />
        </div>
      )}
      {run.status === "running" && b.inFlight.length > 0 && (
        <div className="sync-inflight">
          <span className="sync-inflight__label">Fetching now</span>
          <ul>
            {b.inFlight.slice(0, 8).map((n) => (
              <li key={n}>
                <Badge>{n}</Badge>
              </li>
            ))}
            {b.inFlight.length > 8 && <li className="hint">+{b.inFlight.length - 8} more</li>}
          </ul>
        </div>
      )}
      <p className="sync-timing">
        <span>{duration(run.timing.elapsedMs)} elapsed</span>
        {run.status === "running" && eta && <span> · {eta}</span>}
        {run.timing.avgBoardMs != null && <span> · {(run.timing.avgBoardMs / 1000).toFixed(1)} s a board</span>}
      </p>
    </div>
  );
}

export function RunErrors({ run, open }: { run: SyncProgress; open?: boolean }) {
  if (!run.errors.length) return null;
  return (
    <details className="sync-errors" open={open}>
      <summary>
        <Icon name="warn" size={14} /> {run.errors.length} source{run.errors.length === 1 ? "" : "s"} had a problem
      </summary>
      <ul>
        {run.errors.map((e, i) => (
          <li key={i}>
            <b>{e.source}</b> {e.message}
          </li>
        ))}
      </ul>
      <p className="hint">One source failing never stops a sync. Each one is tried again next time.</p>
    </details>
  );
}
