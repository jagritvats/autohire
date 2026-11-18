"use client";

import { useSyncExternalStore } from "react";
import type { SyncProgress } from "@jobflow/core";
import type { SyncStatusBody } from "./syncApi";

/**
 * One sync watcher per browser tab, shared by the header indicator, the sync panel, the
 * Sources history and the Jobs page. It listens to /api/sync/stream (server-sent events)
 * and falls back to polling GET /api/sync when the stream can't be held open (a proxy that
 * buffers, an old browser): every 2 s while a run is going, every 60 s when idle. The
 * stream is retried now and then. Nothing here starts a sync on its own.
 */

export type SyncView = SyncStatusBody;

export interface SyncSnapshot {
  status: SyncView | null;
  /** "live" = the SSE stream; "polling" = the fallback */
  transport: "connecting" | "live" | "polling";
  error: string | null;
}

type Finished = (run: SyncProgress, status: SyncView) => void;

let snapshot: SyncSnapshot = { status: null, transport: "connecting", error: null };
const listeners = new Set<() => void>();
const finishListeners = new Set<Finished>();
let refs = 0;
let es: EventSource | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** the run we last saw running — its end is announced once */
let watchingRun: string | null = null;

function set(next: Partial<SyncSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((fn) => fn());
}

function applyStatus(status: SyncView) {
  const prevRun = watchingRun;
  watchingRun = status.current?.runId ?? null;
  set({ status, error: null });
  if (prevRun && !status.current && status.last && status.last.runId === prevRun) {
    finishListeners.forEach((fn) => fn(status.last!, status));
  }
}

function applyProgress(run: SyncProgress) {
  const status = snapshot.status;
  if (!status) return;
  if (run.status === "running") watchingRun = run.runId;
  set({ status: { ...status, current: run.status === "running" ? run : status.current } });
}

async function fetchStatus(): Promise<SyncView | null> {
  try {
    const r = await fetch("/api/sync", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as SyncView;
  } catch {
    return null;
  }
}

function schedulePoll() {
  if (pollTimer || !refs) return;
  const wait = snapshot.status?.current ? 2_000 : 60_000;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const s = await fetchStatus();
    if (s) applyStatus(s);
    else set({ error: "Can't reach JobFlow to check the sync." });
    if (snapshot.transport === "polling") schedulePoll();
  }, wait);
}

function openStream() {
  if (typeof window === "undefined" || es || !refs) return;
  if (typeof EventSource === "undefined") return startPolling();
  let opened = false;
  const source = new EventSource("/api/sync/stream");
  es = source;
  source.addEventListener("open", () => {
    opened = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    set({ transport: "live" });
  });
  source.addEventListener("status", (e) => applyStatus(JSON.parse((e as MessageEvent).data) as SyncView));
  source.addEventListener("progress", (e) => applyProgress(JSON.parse((e as MessageEvent).data) as SyncProgress));
  source.addEventListener("error", () => {
    // EventSource reconnects by itself after a drop; if it never opened, or keeps failing,
    // poll instead and try the stream again later
    if (!opened || source.readyState === EventSource.CLOSED) {
      source.close();
      es = null;
      startPolling();
      retryTimer ??= setTimeout(() => {
        retryTimer = null;
        openStream();
      }, 60_000);
    }
  });
}

function startPolling() {
  set({ transport: "polling" });
  void fetchStatus().then((s) => s && applyStatus(s));
  schedulePoll();
}

function connect() {
  void fetchStatus().then((s) => s && !snapshot.status && applyStatus(s));
  openStream();
}

function disconnect() {
  es?.close();
  es = null;
  if (pollTimer) clearTimeout(pollTimer);
  if (retryTimer) clearTimeout(retryTimer);
  pollTimer = retryTimer = null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (refs++ === 0) connect();
  return () => {
    listeners.delete(fn);
    if (--refs === 0) disconnect();
  };
}

const SERVER_SNAPSHOT: SyncSnapshot = { status: null, transport: "connecting", error: null };

/** the shared sync status (re-renders on every change) */
export function useSyncStatus(): SyncSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}

/** be told once when a run you watched ends (the Jobs page offers its new matches). */
export function onSyncFinished(fn: Finished): () => void {
  finishListeners.add(fn);
  return () => void finishListeners.delete(fn);
}

/** start a sync; resolves to an error message, or null when it started */
export async function startSync(): Promise<string | null> {
  try {
    const r = await fetch("/api/sync", { method: "POST" });
    const d = (await r.json().catch(() => ({}))) as { error?: string; status?: SyncView };
    if (!r.ok) return d.error ?? "Couldn't start a sync.";
    if (d.status) applyStatus(d.status);
    if (snapshot.transport === "polling") {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      schedulePoll();
    }
    return null;
  } catch {
    return "Couldn't reach JobFlow to start a sync.";
  }
}

/** ask the running sync to stop */
export async function cancelSync(): Promise<string | null> {
  try {
    const r = await fetch("/api/sync", { method: "DELETE" });
    const d = (await r.json().catch(() => ({}))) as { error?: string; status?: SyncView };
    if (d.status) applyStatus(d.status);
    if (r.status === 409) return null; // it had already finished
    return r.ok ? null : (d.error ?? "Couldn't cancel the sync.");
  } catch {
    return "Couldn't reach JobFlow to cancel the sync.";
  }
}

// ── formatting shared by the indicator, panel and history ──

export function relTime(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso == null) return "never";
  const ms = now - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function untilTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const m = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (m <= 1) return "soon";
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `in ${h} h${rest >= 5 ? ` ${rest} min` : ""}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

/** "about 2 min left" — rounded so it doesn't jitter */
export function etaText(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms < 15_000) return "almost done";
  if (ms < 60_000) return "under a minute left";
  const m = Math.round(ms / 60_000);
  return `about ${m} min left`;
}

export const TRIGGER_LABEL: Record<SyncProgress["trigger"], string> = {
  manual: "You started it",
  scheduled: "Scheduled",
  catch_up: "Catching up",
  first_run: "First sync",
  search: "Saved search",
};

export const ORIGIN_LABEL: Record<SyncProgress["origin"], string> = { web: "web app", cli: "terminal", mcp: "assistant (MCP)", worker: "worker" };
