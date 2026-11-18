import { z } from "zod";

/**
 * The ONE progress model of a corpus sync (discover → poll → expire → rank), shared by the
 * web indicator/panel, `jobflow sync` and the MCP `sync_sources` tool. The live state and
 * the persisted summary are the same shape: a finished run is its last progress snapshot.
 *
 * The corpus is shared, so a run is global — but a custom source belongs to its tenants:
 * entries carrying `tenantIds` are shown only to those tenants (invariant #7). Per-user
 * results ("N new matches for you") are computed at read time for the caller, never stored.
 */

const ts = z.union([z.string().datetime({ offset: true }), z.date()]);

/** why a sync started */
export const SyncTrigger = z.enum(["manual", "scheduled", "catch_up", "first_run", "search"]);
export type SyncTrigger = z.infer<typeof SyncTrigger>;

/** which program ran it */
export const SyncOrigin = z.enum(["web", "cli", "mcp", "worker"]);
export type SyncOrigin = z.infer<typeof SyncOrigin>;

export const SyncStatus = z.enum(["running", "done", "cancelled", "failed"]);
export type SyncStatus = z.infer<typeof SyncStatus>;

/**
 * The phases, in the order a run goes through them. `renormalize` re-derives stored
 * postings once after a parser upgrade (skipped when the store is current); `discover` registers new seed
 * employers and resolves them to boards; `boards` polls ATS boards; `feeds` runs discovery
 * feeds, your own sources and saved searches; `resolve` upgrades companies found in feeds to
 * their boards (polled next run); `expire` retires postings nobody re-confirmed; `process`
 * re-derives what's computed from the corpus (normalization, pay estimates); `rank` scores it.
 */
export const SYNC_PHASES = ["renormalize", "discover", "boards", "feeds", "resolve", "expire", "process", "rank"] as const;
export const SyncPhaseId = z.enum(SYNC_PHASES);
export type SyncPhaseId = z.infer<typeof SyncPhaseId>;

export const SYNC_PHASE_LABEL: Record<SyncPhaseId, string> = {
  renormalize: "Re-check stored jobs",
  discover: "Find new companies",
  boards: "Check job boards",
  feeds: "Read feeds and searches",
  resolve: "Match companies to boards",
  expire: "Retire closed jobs",
  process: "Tidy and estimate pay",
  rank: "Rank for you",
};

export const SyncPhaseState = z.object({
  id: SyncPhaseId,
  status: z.enum(["pending", "active", "done", "skipped"]),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
});
export type SyncPhaseState = z.infer<typeof SyncPhaseState>;

export const SyncError = z.object({
  /** the board, feed or step it came from, in words a person recognises */
  source: z.string(),
  /** plain language: what went wrong and, when known, why */
  message: z.string(),
  /** set for a tenant's own custom source / saved search: only these tenants see it */
  tenantIds: z.array(z.string()).optional(),
});
export type SyncError = z.infer<typeof SyncError>;

/** one feed / custom source / saved search / community channel, as it went this run */
export const SyncSourceResult = z.object({
  label: z.string(),
  kind: z.enum(["feed", "custom", "search", "channel"]),
  status: z.enum(["running", "ok", "empty", "error", "skipped"]),
  fetched: z.number().default(0),
  created: z.number().default(0),
  ms: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  tenantIds: z.array(z.string()).optional(),
});
export type SyncSourceResult = z.infer<typeof SyncSourceResult>;

export const SyncProgress = z.object({
  runId: z.string(),
  trigger: SyncTrigger,
  origin: SyncOrigin,
  status: SyncStatus,
  /** epoch ms (numbers, so the live state serializes cheaply over SSE) */
  startedAt: z.number(),
  finishedAt: z.number().nullable().default(null),
  cancelRequested: z.boolean().default(false),
  phase: SyncPhaseId.nullable().default(null),
  phases: z.array(SyncPhaseState),
  boards: z.object({
    /** boards this run means to poll */
    total: z.number().default(0),
    done: z.number().default(0),
    failed: z.number().default(0),
    /** active boards not due yet by their cadence (polled on a later run) */
    notDue: z.number().default(0),
    /** due boards held back by the per-run board cap (they lead the next run) */
    deferred: z.number().default(0),
    /** planned boards this run didn't start (time budget reached, or cancelled) */
    skipped: z.number().default(0),
    /** board names being fetched right now */
    inFlight: z.array(z.string()).default([]),
  }),
  feeds: z.object({ total: z.number().default(0), done: z.number().default(0), failed: z.number().default(0) }),
  postings: z.object({
    fetched: z.number().default(0),
    new: z.number().default(0),
    updated: z.number().default(0),
    /** soft-deleted: their board no longer lists them */
    gone: z.number().default(0),
    /** retired by the not-seen-for-a-while sweep */
    expired: z.number().default(0),
  }),
  /** new boards found this run (from feeds, channels, seeds) */
  resolved: z.number().default(0),
  timing: z.object({
    elapsedMs: z.number().default(0),
    /** best guess of the time left; null when there's nothing to go on yet */
    etaMs: z.number().nullable().default(null),
    /** the board-fetch time budget (null = none) */
    budgetMs: z.number().nullable().default(null),
    avgBoardMs: z.number().nullable().default(null),
    concurrency: z.number().default(1),
    /** how long each step took on the previous run — the ETA's guess for steps not reached yet */
    priorPhaseMs: z.record(z.number()).optional(),
  }),
  errors: z.array(SyncError).default([]),
  /** feeds, custom sources, saved searches and channels this run, by key */
  sources: z.record(SyncSourceResult).default({}),
  /** a one-line outcome once finished ("Fetched 412 jobs, 37 new") */
  message: z.string().nullable().default(null),
});
export type SyncProgress = z.infer<typeof SyncProgress>;

/** a persisted run: the final progress snapshot plus its keys */
export const SyncRunRecord = z.object({
  id: z.string(),
  trigger: SyncTrigger,
  origin: SyncOrigin,
  status: SyncStatus,
  startedAt: ts,
  finishedAt: ts.nullable(),
  summary: SyncProgress,
});
export type SyncRunRecord = z.infer<typeof SyncRunRecord>;
