import { SYNC_PHASES, SYNC_PHASE_LABEL, type SyncOrigin, type SyncPhaseId, type SyncProgress, type SyncTrigger } from "@jobflow/core";
import type { PollEvent } from "@jobflow/pipeline";

/**
 * The sync progress model, as pure functions: a fresh state, folding one pipeline event into
 * it, the ETA, the finish line, the per-tenant view and plain-language errors. The run
 * manager (`sync.ts`) owns the live state; the web, CLI and MCP only render it.
 */

/** keep the live state small enough to stream several times a second */
const MAX_ERRORS = 60;
/** a feed with no timing yet is guessed at this */
const FEED_GUESS_MS = 3_000;
/** resolve + expire + process + rank, when nothing better is known */
const TAIL_GUESS_MS = 6_000;

export function newSyncProgress(o: { runId: string; trigger: SyncTrigger; origin: SyncOrigin; now?: number }): SyncProgress {
  const now = o.now ?? Date.now();
  return {
    runId: o.runId,
    trigger: o.trigger,
    origin: o.origin,
    status: "running",
    startedAt: now,
    finishedAt: null,
    cancelRequested: false,
    phase: null,
    phases: SYNC_PHASES.map((id) => ({ id, status: "pending" as const, startedAt: null, finishedAt: null })),
    boards: { total: 0, done: 0, failed: 0, notDue: 0, deferred: 0, skipped: 0, inFlight: [] },
    feeds: { total: 0, done: 0, failed: 0 },
    postings: { fetched: 0, new: 0, updated: 0, gone: 0, expired: 0 },
    resolved: 0,
    timing: { elapsedMs: 0, etaMs: null, budgetMs: null, avgBoardMs: null, concurrency: 1 },
    errors: [],
    sources: {},
    message: null,
  };
}

/** Fold one pipeline event into the state (mutates and returns it). */
export function applySyncEvent(s: SyncProgress, e: PollEvent, now: number = Date.now()): SyncProgress {
  switch (e.type) {
    case "phase": {
      const ph = s.phases.find((p) => p.id === e.phase);
      if (!ph) break;
      if (e.state === "start") {
        ph.status = "active";
        ph.startedAt = now;
        s.phase = e.phase;
      } else {
        ph.status = e.state === "done" ? "done" : "skipped";
        ph.startedAt ??= e.state === "done" ? now : null;
        ph.finishedAt = now;
        if (s.phase === e.phase) s.phase = null;
      }
      break;
    }
    case "plan":
      s.boards.total = e.boards;
      s.boards.deferred = e.deferred;
      s.boards.notDue = e.notDue;
      s.timing.budgetMs = e.budgetMs;
      s.timing.concurrency = Math.max(1, e.concurrency);
      break;
    case "board":
      if (e.state === "start") {
        if (!s.boards.inFlight.includes(e.name)) s.boards.inFlight.push(e.name);
      } else if (e.state === "deferred") {
        s.boards.skipped++;
      } else {
        dropInFlight(s, e.name);
        if (e.error && e.fetched === 0) {
          s.boards.failed++;
          pushError(s, { source: e.name, message: plainError(e.error) });
        } else s.boards.done++;
        const n = s.boards.done + s.boards.failed;
        s.timing.avgBoardMs = s.timing.avgBoardMs == null ? e.ms : (s.timing.avgBoardMs * (n - 1) + e.ms) / n;
        s.postings.fetched += e.fetched;
        s.postings.new += e.created;
        s.postings.updated += e.updated;
        s.postings.gone += e.staled;
      }
      break;
    case "feeds":
      s.feeds.total = e.total;
      break;
    case "source":
      if (e.state === "start") {
        s.sources[e.key] = {
          label: e.label,
          kind: e.kind,
          status: "running",
          fetched: 0,
          created: 0,
          ms: null,
          error: null,
          ...(e.tenantIds ? { tenantIds: e.tenantIds } : {}),
        };
      } else {
        const src = s.sources[e.key];
        const failed = !!e.error && e.fetched === 0;
        if (src) {
          src.status = failed ? "error" : e.fetched ? "ok" : "empty";
          src.fetched = e.fetched;
          src.created = e.created;
          src.ms = e.ms;
          src.error = e.error ? plainError(e.error) : null;
          if (failed) pushError(s, { source: src.label, message: plainError(e.error!), ...(src.tenantIds ? { tenantIds: src.tenantIds } : {}) });
        }
        if (failed) s.feeds.failed++;
        else s.feeds.done++;
        s.postings.fetched += e.fetched;
        s.postings.new += e.created;
        s.postings.updated += Math.max(0, e.fetched - e.created);
      }
      break;
    case "resolved":
      s.resolved += e.count;
      break;
    case "expired":
      s.postings.expired = e.count;
      break;
    case "error":
      pushError(s, { source: e.source, message: plainError(e.message), ...(e.tenantIds ? { tenantIds: e.tenantIds } : {}) });
      break;
  }
  return syncTick(s, now);
}

/** refresh the clock fields (elapsed, ETA) */
export function syncTick(s: SyncProgress, now: number = Date.now()): SyncProgress {
  s.timing.elapsedMs = Math.max(0, (s.finishedAt ?? now) - s.startedAt);
  s.timing.etaMs = s.status === "running" ? estimateEtaMs(s, now) : null;
  return s;
}

/**
 * Time left, from what's measured: boards left × the average board time ÷ the boards
 * fetched at once — never past the board time budget (the run stops starting boards there)
 * — plus the feeds left at their average, plus a small tail for resolve/expire/rank. Null
 * while there is nothing to go on (no board has finished yet).
 */
export function estimateEtaMs(s: SyncProgress, now: number = Date.now()): number | null {
  if (s.status !== "running") return null;
  if (s.cancelRequested) return null;
  const status = (id: SyncPhaseId) => s.phases.find((p) => p.id === id)?.status ?? "pending";
  const open = (id: SyncPhaseId) => status(id) === "pending" || status(id) === "active";
  if (status("discover") === "active") return null;

  let eta = 0;
  if (open("boards")) {
    const left = Math.max(0, s.boards.total - s.boards.done - s.boards.failed - s.boards.skipped);
    if (left > 0) {
      const avg = s.timing.avgBoardMs;
      if (avg == null) return null;
      let boardsMs = (left * avg) / Math.max(1, s.timing.concurrency);
      const started = s.phases.find((p) => p.id === "boards")?.startedAt;
      if (s.timing.budgetMs != null && started != null) {
        // past the budget nothing new starts; what's in flight still finishes
        const budgetLeft = Math.max(0, started + s.timing.budgetMs - now);
        boardsMs = Math.min(boardsMs, budgetLeft + avg);
      }
      eta += boardsMs;
    }
  }
  if (open("feeds")) {
    const timed = Object.values(s.sources).filter((x) => x.ms != null);
    const avgFeed = timed.length ? timed.reduce((a, x) => a + (x.ms ?? 0), 0) / timed.length : FEED_GUESS_MS;
    const left = s.feeds.total ? Math.max(0, s.feeds.total - s.feeds.done - s.feeds.failed) : 4;
    eta += left * avgFeed;
  }
  if (status("rank") !== "done" && status("rank") !== "skipped") eta += TAIL_GUESS_MS;
  return Math.round(eta);
}

/** 0..1 across the whole run, weighted to where the time goes (the boards). */
export function syncFraction(s: SyncProgress): number {
  if (s.status !== "running") return 1;
  const weight: Record<SyncPhaseId, number> = { discover: 0.05, boards: 0.65, feeds: 0.15, resolve: 0.04, expire: 0.03, process: 0.03, rank: 0.05 };
  let f = 0;
  for (const p of s.phases) {
    const w = weight[p.id];
    if (p.status === "done" || p.status === "skipped") f += w;
    else if (p.status === "active") {
      if (p.id === "boards" && s.boards.total) f += (w * (s.boards.done + s.boards.failed + s.boards.skipped)) / s.boards.total;
      else if (p.id === "feeds" && s.feeds.total) f += (w * (s.feeds.done + s.feeds.failed)) / s.feeds.total;
    }
  }
  return Math.min(0.99, Math.max(0, f));
}

/** the run's one-line outcome */
export function syncMessage(s: SyncProgress): string {
  const p = s.postings;
  const parts = [`${p.fetched} job${p.fetched === 1 ? "" : "s"} fetched`, `${p.new} new`];
  if (p.gone + p.expired) parts.push(`${p.gone + p.expired} closed`);
  const checked = `Checked ${s.boards.done + s.boards.failed} board${s.boards.done + s.boards.failed === 1 ? "" : "s"}${s.feeds.total ? ` and ${s.feeds.done + s.feeds.failed} feed${s.feeds.done + s.feeds.failed === 1 ? "" : "s"}` : ""}`;
  const left = s.boards.deferred + s.boards.skipped;
  const tail = left ? ` ${left} board${left === 1 ? "" : "s"} wait${left === 1 ? "s" : ""} for the next sync.` : "";
  if (s.status === "cancelled") return `Cancelled. ${checked} first: ${parts.join(", ")}. Nothing was retired from a partial run.${tail}`;
  if (s.status === "failed") return `The sync stopped with an error. ${checked}: ${parts.join(", ")}.`;
  return `${checked}: ${parts.join(", ")}.${tail}`;
}

/** what a phase is called in the UI */
export function phaseLabel(id: SyncPhaseId): string {
  return SYNC_PHASE_LABEL[id];
}

/**
 * The run as one tenant may see it: a custom source or saved search belongs to the tenants
 * that added it, so other tenants never see its label or errors (invariant #7). Returns a
 * copy with fresh clock fields.
 */
export function syncViewFor(s: SyncProgress, tenantId: string, now: number = Date.now()): SyncProgress {
  const mine = (ids?: string[]) => !ids || ids.includes(tenantId);
  const copy: SyncProgress = structuredClone(s);
  copy.errors = copy.errors.filter((e) => mine(e.tenantIds)).map(({ tenantIds: _t, ...e }) => e);
  copy.sources = Object.fromEntries(
    Object.entries(copy.sources)
      .filter(([, v]) => mine(v.tenantIds))
      .map(([k, { tenantIds: _t, ...v }]) => [k, v]),
  );
  return syncTick(copy, now);
}

/** Plain language for the errors fetchers raise: what went wrong and, when known, why. */
export function plainError(raw: string): string {
  const m = raw.replace(/\s+/g, " ").trim();
  const low = m.toLowerCase();
  if (/abort|timed? ?out|timeout|etimedout/.test(low)) return "didn't answer in time (timed out)";
  if (/\b404\b|not found/.test(low)) return "not found (404) — the board may have moved or closed";
  if (/\b410\b/.test(low)) return "gone (410) — the board was removed";
  if (/\b429\b|rate.?limit|too many requests/.test(low)) return "asked us to slow down (rate limited) — it's retried next sync";
  if (/\b40[13]\b|forbidden|unauthori[sz]ed/.test(low)) return "refused the request (blocked or needs a login)";
  if (/\b5\d\d\b|bad gateway|service unavailable/.test(low)) return "had a server error on its side — it's retried next sync";
  if (/enotfound|eai_again|getaddrinfo|dns/.test(low)) return "couldn't be reached (no network, or the name doesn't resolve)";
  if (/econnrefused|econnreset|socket hang up|network|fetch failed/.test(low)) return "couldn't be reached (connection failed — offline or a proxy blocking it)";
  if (/certificate|tls|ssl/.test(low)) return "couldn't be reached securely (a certificate problem, often a proxy)";
  if (/unexpected token|json|parse/.test(low)) return "answered with something we couldn't read";
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

function dropInFlight(s: SyncProgress, name: string): void {
  const i = s.boards.inFlight.indexOf(name);
  if (i >= 0) s.boards.inFlight.splice(i, 1);
}

function pushError(s: SyncProgress, e: SyncProgress["errors"][number]): void {
  if (s.errors.length < MAX_ERRORS) s.errors.push(e);
}
