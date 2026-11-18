import type { Repository } from "@jobflow/db";
import type { SyncProgress } from "@jobflow/core";
import { cancelCorpusSync, currentSyncRun, rankTenant, startCorpusSync, subscribeSync, syncStatus, syncViewFor, type SyncStatusView } from "@jobflow/service";

/**
 * The sync API's logic, apart from Next so it is testable with any repository. Every
 * function takes the CALLER (tenant + role from guard/withAuth) — never a built-in tenant
 * (invariant #7). Starting or cancelling a sync of the shared corpus is an admin action on
 * a multi-user instance; anyone may watch it. Nothing here polls inside the request: start
 * returns at once and the page watches the run.
 */

export interface SyncCaller {
  tenantId: string;
  role: string;
}

export interface SyncStatusBody extends SyncStatusView {
  /** may this caller start / cancel a sync? */
  canSync: boolean;
}

const MEMBER_SYNC = "Syncing the shared job list is an admin action here; your Jobs re-rank after each scheduled sync.";

export async function syncStatusBody(repo: Repository, caller: SyncCaller): Promise<SyncStatusBody> {
  return { ...(await syncStatus(repo, caller.tenantId)), canSync: caller.role === "admin" };
}

export async function getSync(repo: Repository, caller: SyncCaller): Promise<Response> {
  return json(await syncStatusBody(repo, caller));
}

/** Start (or join) a background sync, then rank the caller. Returns at once. */
export async function postSync(repo: Repository, caller: SyncCaller): Promise<Response> {
  if (caller.role !== "admin") return json({ started: false, error: MEMBER_SYNC }, 403);
  void startCorpusSync(repo, async () => void (await rankTenant(repo, caller.tenantId)), undefined, { trigger: "manual", origin: "web" });
  return json({ started: true, status: await syncStatusBody(repo, caller) }, 202);
}

/** Ask the running sync to stop (it keeps what it fetched; nothing is retired). */
export async function deleteSync(repo: Repository, caller: SyncCaller): Promise<Response> {
  if (caller.role !== "admin") return json({ cancelled: false, error: MEMBER_SYNC }, 403);
  const cancelled = cancelCorpusSync();
  return json({ cancelled, status: await syncStatusBody(repo, caller) }, cancelled ? 202 : 409);
}

/**
 * Server-sent events: `status` (the whole view: on connect and whenever a run ends) and
 * `progress` (the live run, at most every `throttleMs`, and every `clockMs` while running so
 * elapsed time and the ETA keep moving between board completions). A `: ping` comment keeps
 * proxies from closing an idle stream. The stream ends when the client goes away.
 */
export function syncStream(
  repo: Repository,
  caller: SyncCaller,
  signal: AbortSignal,
  opts: { throttleMs?: number; clockMs?: number; pingMs?: number } = {},
): Response {
  const throttleMs = opts.throttleMs ?? 300;
  const clockMs = opts.clockMs ?? 2_000;
  const pingMs = opts.pingMs ?? 15_000;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last = 0;
      let pending: SyncProgress | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let running = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          stop();
        }
      };
      const sendStatus = async () => {
        try {
          send("status", await syncStatusBody(repo, caller));
        } catch {
          /* the next change retries */
        }
      };
      const flush = () => {
        flushTimer = null;
        if (!pending) return;
        last = Date.now();
        send("progress", syncViewFor(pending, caller.tenantId));
        pending = null;
      };
      const unsubscribe = subscribeSync((s) => {
        if (s.status !== "running") {
          // a run ended: drop any queued frame and send the full view (history, your matches)
          running = false;
          pending = null;
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = null;
          void sendStatus();
          return;
        }
        if (!running) {
          running = true;
          void sendStatus();
          return;
        }
        pending = s;
        const wait = throttleMs - (Date.now() - last);
        if (wait <= 0) flush();
        else flushTimer ??= setTimeout(flush, wait);
      });
      const clock = setInterval(() => {
        if (!running) return;
        const cur = currentSyncRun();
        if (cur) send("progress", syncViewFor(cur, caller.tenantId));
      }, clockMs);
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          stop();
        }
      }, pingMs);
      function stop() {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(clock);
        clearInterval(ping);
        if (flushTimer) clearTimeout(flushTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      cleanup = stop;
      signal.addEventListener("abort", stop);
      // retry hint for EventSource reconnects, then the opening view
      controller.enqueue(enc.encode("retry: 5000\n\n"));
      void syncStatusBody(repo, caller)
        .then((v) => {
          running = v.current != null;
          send("status", v);
        })
        .catch(() => {});
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform: the compression middleware leaves the stream alone (no buffering)
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
