import type { SyncPhaseId } from "@jobflow/core";

/**
 * What `pollAll` reports while it runs. The pipeline only EMITS facts (a board started, a
 * feed finished, a phase was skipped); the service folds them into the one `SyncProgress`
 * model (service `sync-progress.ts`) that the web, CLI and MCP all render. Emitting never
 * throws into the poll: a listener error is swallowed (`emitter`).
 */
export type PollEvent =
  | { type: "phase"; phase: SyncPhaseId; state: "start" | "done" | "skipped" }
  | {
      type: "plan";
      /** boards this run means to poll */
      boards: number;
      /** due boards held back by the per-run cap (the time budget may defer more later) */
      deferred: number;
      /** active boards not due yet */
      notDue: number;
      budgetMs: number | null;
      concurrency: number;
    }
  | { type: "board"; state: "start"; id: string; name: string }
  | {
      type: "board";
      state: "done";
      id: string;
      name: string;
      fetched: number;
      created: number;
      updated: number;
      staled: number;
      ms: number;
      error?: string;
    }
  /** a planned board not started (time budget reached, or the run was cancelled) */
  | { type: "board"; state: "deferred"; id: string; name: string }
  /** the feeds-phase work list, once known */
  | { type: "feeds"; total: number }
  | { type: "source"; state: "start"; key: string; label: string; kind: "feed" | "custom" | "search" | "channel"; tenantIds?: string[] }
  | {
      type: "source";
      state: "done";
      key: string;
      fetched: number;
      created: number;
      ms: number;
      error?: string | null;
    }
  | { type: "resolved"; count: number }
  | { type: "expired"; count: number }
  | { type: "error"; source: string; message: string; tenantIds?: string[] };

export type PollListener = (e: PollEvent) => void;

/** a listener that can't break the poll */
export function emitter(fn: PollListener | undefined): PollListener {
  if (!fn) return () => {};
  return (e) => {
    try {
      fn(e);
    } catch {
      /* progress is best effort */
    }
  };
}
