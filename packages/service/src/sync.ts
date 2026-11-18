import { randomUUID } from "node:crypto";
import type { SyncOrigin, SyncProgress, SyncTrigger } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { isOnboarded, type PollListener, type PollStats } from "@jobflow/pipeline";
import { rankTenant, syncCorpus, type SyncOptions } from "./feed.js";
import { applySyncEvent, newSyncProgress, phaseDurations, syncMessage, syncTick, syncViewFor } from "./sync-progress.js";

/**
 * Sync runs: one corpus sync at a time per process, observable while it runs and kept
 * afterwards. Every caller goes through `startCorpusSync` — the web's background sync and
 * schedule, `jobflow sync`, the MCP tool — so they share the one progress model
 * (`SyncProgress`), the cancel path and the history. The web never polls inside a request:
 * routes start a run and return; the page watches it (SSE, or polling as a fallback).
 *
 * State lives on globalThis so every bundle of a Next server (pages, route handlers) sees
 * the same run.
 */

/** a match at or above this score counts as "a new match for you" (the fair-or-better band) */
export const NEW_MATCH_SCORE = 60;
/** the strong band */
export const STRONG_MATCH_SCORE = 78;
/** finished runs kept in memory for this process (the store keeps more) */
const RECENT_KEPT = 20;

type Listener = (s: SyncProgress) => void;

interface ActiveRun {
  state: SyncProgress;
  controller: AbortController;
  promise: Promise<void>;
  stats: PollStats | null;
}

interface SyncSchedule {
  /** how often the local schedule syncs */
  everyMs: number;
  /** when it next looks */
  nextCheckAt: number;
  /** boards were never polled: it syncs at the next look instead of waiting the period */
  catchUp: boolean;
}

interface Hub {
  current: ActiveRun | null;
  recent: SyncProgress[];
  listeners: Set<Listener>;
  afterSync: Array<() => Promise<void>>;
  schedule: SyncSchedule | null;
}

const KEY = Symbol.for("jobflow.sync.hub");
function hub(): Hub {
  const g = globalThis as unknown as Record<symbol, Hub | undefined>;
  return (g[KEY] ??= { current: null, recent: [], listeners: new Set(), afterSync: [], schedule: null });
}

/** Is a corpus sync running in this process? */
export function corpusSyncing(): boolean {
  return hub().current != null;
}

/** the live run (unfiltered — callers that show it to a person use `syncStatus`) */
export function currentSyncRun(): SyncProgress | null {
  const cur = hub().current;
  return cur ? syncTick(cur.state) : null;
}

/** Watch every change of the live run (start, each event, the finish). Returns unsubscribe. */
export function subscribeSync(fn: Listener): () => void {
  const h = hub();
  h.listeners.add(fn);
  return () => void h.listeners.delete(fn);
}

function notify(s: SyncProgress): void {
  for (const fn of hub().listeners) {
    try {
      fn(s);
    } catch {
      /* a broken watcher never breaks the sync */
    }
  }
}

/** The poll a run executes; given the progress hooks. Tests inject a fake. */
export type SyncRunner = (repo: Repository, hooks: { onProgress: PollListener; signal: AbortSignal }) => Promise<unknown>;

export interface StartSyncOptions {
  trigger?: SyncTrigger;
  origin?: SyncOrigin;
}

/**
 * Start (or join) a corpus sync: discover → poll → expire → (after) rank. Deduped:
 * concurrent callers share one run, and each joiner's `after` still runs when it ends (a
 * person who finishes onboarding while the first browse sync runs still gets ranked).
 * Request handlers never await it — the UI watches the run instead.
 */
export function startCorpusSync(
  repo: Repository,
  after?: () => Promise<void>,
  sync: SyncRunner = (r, hooks) => syncCorpus(r, hooks),
  opts: StartSyncOptions = {},
): Promise<void> {
  const h = hub();
  if (after) h.afterSync.push(after);
  if (h.current) return h.current.promise;

  const state = newSyncProgress({ runId: randomUUID(), trigger: opts.trigger ?? "manual", origin: opts.origin ?? "web" });
  // the ETA guesses the steps it hasn't reached from the last finished run (this process's,
  // else the store's)
  const prior = h.recent.find((r) => r.status === "done");
  if (prior) state.timing.priorPhaseMs = phaseDurations(prior);
  else
    void repo
      .listSyncRuns(5)
      .then((runs) => {
        const last = runs.find((r) => r.status === "done");
        if (last && !state.timing.priorPhaseMs) state.timing.priorPhaseMs = phaseDurations(last.summary);
      })
      .catch(() => {});
  const controller = new AbortController();
  const run: ActiveRun = { state, controller, stats: null, promise: Promise.resolve() };
  h.current = run;
  const onProgress: PollListener = (e) => {
    applySyncEvent(state, e);
    notify(state);
  };
  notify(state);

  run.promise = (async () => {
    let failed = false;
    try {
      const out = await sync(repo, { onProgress, signal: controller.signal });
      if (out && typeof out === "object" && "companiesPolled" in out) run.stats = out as PollStats;
    } catch (e) {
      failed = true;
      console.error("[jobflow] corpus sync failed:", e instanceof Error ? e.message : e);
      onProgress({ type: "error", source: "sync", message: e instanceof Error ? e.message : String(e) });
    }
    // still "running" until every follow-up (ranking) is done, so the UI never reads a
    // finished-but-unranked feed; steps added meanwhile run in this same loop. A cancelled
    // run still ranks what it fetched (consistent, and it's what makes those jobs visible).
    if (h.afterSync.length) {
      onProgress({ type: "phase", phase: "rank", state: "start" });
      while (h.afterSync.length) {
        const fn = h.afterSync.shift()!;
        try {
          await fn();
        } catch (e) {
          console.error("[jobflow] after-sync step failed:", e instanceof Error ? e.message : e);
          onProgress({ type: "error", source: "ranking", message: e instanceof Error ? e.message : String(e) });
        }
      }
      onProgress({ type: "phase", phase: "rank", state: "done" });
    } else onProgress({ type: "phase", phase: "rank", state: "skipped" });

    // phases a fake runner (or an early stop) never reported read as skipped, not pending
    for (const p of state.phases) if (p.status === "pending" || p.status === "active") p.status = p.status === "active" ? "done" : "skipped";
    state.boards.inFlight = [];
    state.status = failed ? "failed" : controller.signal.aborted ? "cancelled" : "done";
    state.finishedAt = Date.now();
    state.phase = null;
    syncTick(state);
    state.message = syncMessage(state);
    h.recent = [structuredClone(state), ...h.recent.filter((r) => r.runId !== state.runId)].slice(0, RECENT_KEPT);
    await repo
      .saveSyncRun({
        id: state.runId,
        trigger: state.trigger,
        origin: state.origin,
        status: state.status,
        startedAt: new Date(state.startedAt),
        finishedAt: new Date(state.finishedAt),
        summary: structuredClone(state),
      })
      .catch((e: unknown) => console.error("[jobflow] couldn't save the sync summary:", e instanceof Error ? e.message : e));
    h.current = null;
    notify(state);
  })();
  return run.promise;
}

/**
 * Ask the running sync to stop: no new board or feed is started, in-flight fetches finish
 * and are stored, no board is diffed and no sweep runs (invariant #5); what it fetched is
 * still ranked. Returns false when nothing is running.
 */
export function cancelCorpusSync(): boolean {
  const cur = hub().current;
  if (!cur) return false;
  if (!cur.controller.signal.aborted) {
    cur.state.cancelRequested = true;
    cur.controller.abort();
    syncTick(cur.state);
    notify(cur.state);
  }
  return true;
}

/** The local schedule tells the hub when it looks next, so the UI can say "next in 48 min". */
export function setSyncSchedule(s: SyncSchedule | null): void {
  hub().schedule = s;
}

/** When the schedule will next sync: the first look at or after `lastSyncAt + everyMs`. */
export function nextSyncAt(schedule: SyncSchedule | null, lastSyncAt: number | null, now: number = Date.now()): number | null {
  if (!schedule || !(schedule.everyMs > 0)) return null;
  // never synced: the schedule waits for the first sync (the first visit, or Sync now)
  if (lastSyncAt == null) return null;
  const look = Math.max(schedule.nextCheckAt, now);
  if (schedule.catchUp) return look;
  const due = lastSyncAt + schedule.everyMs;
  if (due <= look) return look;
  const period = 15 * 60_000;
  return look + Math.ceil((due - look) / period) * period;
}

/** What one sync means for one person: new matches at or above the thresholds. */
export interface YourSyncResult {
  ranked: boolean;
  /** new postings (first seen since the run started) that match you at NEW_MATCH_SCORE+ */
  newMatches: number;
  strongMatches: number;
  threshold: number;
  since: string;
}

export async function yourSyncResult(repo: Repository, tenantId: string, since: number): Promise<YourSyncResult> {
  const profile = await repo.getProfile(tenantId);
  const base = { threshold: NEW_MATCH_SCORE, since: new Date(since).toISOString() };
  if (!profile || !isOnboarded(profile)) return { ranked: false, newMatches: 0, strongMatches: 0, ...base };
  const matches = await repo.listMatches(tenantId, 5000);
  // a little slack: a posting stored in the same second the run started counts as new
  const fresh = matches.filter((m) => new Date(m.posting.firstSeen as string | Date).getTime() >= since - 1000);
  return {
    ranked: true,
    newMatches: fresh.filter((m) => m.score >= NEW_MATCH_SCORE).length,
    strongMatches: fresh.filter((m) => m.score >= STRONG_MATCH_SCORE).length,
    ...base,
  };
}

/** Everything the sync indicator, panel and Sources history show — as THIS tenant may see it. */
export interface SyncStatusView {
  current: SyncProgress | null;
  /** the newest finished run */
  last: SyncProgress | null;
  /** finished runs, newest first */
  history: SyncProgress[];
  /** the last time the corpus was refreshed (last run's end, else the newest board poll) */
  lastSyncAt: string | null;
  /** the local schedule's next sync (null: no schedule in this process) */
  nextSyncAt: string | null;
  /** what the last finished run brought this tenant */
  you: YourSyncResult | null;
}

export async function syncStatus(repo: Repository, tenantId: string, opts: { history?: number; now?: number } = {}): Promise<SyncStatusView> {
  const now = opts.now ?? Date.now();
  const h = hub();
  const stored = await repo.listSyncRuns(opts.history ?? 10).catch(() => []);
  const byId = new Map<string, SyncProgress>();
  for (const r of h.recent) byId.set(r.runId, r);
  for (const r of stored) if (!byId.has(r.id)) byId.set(r.id, r.summary);
  const history = [...byId.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, opts.history ?? 10)
    .map((r) => syncViewFor(r, tenantId, now));
  const last = history[0] ?? null;
  let lastSyncAt = last?.finishedAt ?? null;
  if (lastSyncAt == null) {
    const polled = (await repo.listCompanies()).map((c) => (c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0));
    const max = Math.max(0, ...polled);
    lastSyncAt = max || null;
  }
  const cur = h.current ? syncViewFor(h.current.state, tenantId, now) : null;
  const next = cur ? null : nextSyncAt(h.schedule, lastSyncAt, now);
  return {
    current: cur,
    last,
    history,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    nextSyncAt: next ? new Date(next).toISOString() : null,
    you: last ? await yourSyncResult(repo, tenantId, last.startedAt) : null,
  };
}

/** A sync awaited to the end (CLI, MCP): the same tracked run, with its stats and your result. */
export interface RunSyncResult {
  progress: SyncProgress;
  stats: PollStats | null;
  ranked: boolean;
  you: YourSyncResult;
}

export async function runSync(
  repo: Repository,
  tenantId: string,
  opts: SyncOptions & {
    trigger?: SyncTrigger;
    origin?: SyncOrigin;
    /** every state change (throttle on your side) */
    onUpdate?: Listener;
    /** cancel from outside (Ctrl-C) */
    signal?: AbortSignal;
    /** the poll to run (tests); default `syncCorpus` with `opts` */
    sync?: SyncRunner;
  } = {},
): Promise<RunSyncResult> {
  const { trigger, origin, onUpdate, signal, sync, ...syncOpts } = opts;
  let ranked = false;
  let last: SyncProgress | null = null;
  const unsubscribe = subscribeSync((s) => {
    last = s;
    onUpdate?.(syncViewFor(s, tenantId));
  });
  const onAbort = () => cancelCorpusSync();
  signal?.addEventListener("abort", onAbort);
  let stats: PollStats | null = null;
  const runner: SyncRunner = async (r, hooks) => {
    const out = await (sync ?? ((rr, hk) => syncCorpus(rr, { ...syncOpts, ...hk })))(r, hooks);
    if (out && typeof out === "object" && "companiesPolled" in out) stats = out as PollStats;
    return out;
  };
  try {
    await startCorpusSync(repo, async () => void (ranked = await rankTenant(repo, tenantId)), runner, { trigger: trigger ?? "manual", origin: origin ?? "cli" });
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
  const done = (last as SyncProgress | null) ?? hub().recent[0]!;
  return { progress: syncViewFor(done, tenantId), stats, ranked, you: await yourSyncResult(repo, tenantId, done.startedAt) };
}
