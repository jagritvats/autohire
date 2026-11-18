import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repository } from "@jobflow/db";
import { ensureTenant } from "@jobflow/service";

/**
 * How the MCP server reaches the store. An MCP client keeps the server process alive for
 * as long as the chat is open — often all day — so it must NOT hold the PGlite
 * single-writer lock for its lifetime (that would lock out `jobflow` and the web app).
 * Instead the repository is opened lazily on the first tool call, tool calls are
 * serialised, and the repository is closed again after a short idle period. A data dir
 * held by another process becomes a plain-language tool error, never a crash.
 */

export interface RepoAccess {
  /** run `fn` with the (lazily opened) repository; calls are serialised */
  withRepo<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
  /** close now (shutdown) */
  close(): Promise<void>;
  /** is a repository currently open (and so, for PGlite, the lock held)? */
  readonly isOpen: boolean;
}

/** The data dir is held by another process (PGlite is single-writer). */
export class StoreBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreBusyError";
  }
}

const LOCKED = /in use by another process|is locked by pid|already open in this process/;

export interface LocalStoreOptions {
  /** open (and migrate) the repository — e.g. `createRepository({ store, dataDir })` */
  open: () => Promise<Repository>;
  tenantId: string;
  /** close after this long without a call; `null` = keep it open (the in-memory store) */
  idleMs?: number | null;
  /** for the busy message: where the data lives (reads `server.json` there) */
  dataDir?: string;
  /** a lock held by a short CLI command clears quickly: retry this many times… */
  busyRetries?: number;
  /** …this far apart */
  busyRetryMs?: number;
}

export const DEFAULT_IDLE_MS = 20_000;

export function createLocalStore(opts: LocalStoreOptions): RepoAccess {
  const idleMs = opts.idleMs === undefined ? DEFAULT_IDLE_MS : opts.idleMs;
  const retries = opts.busyRetries ?? 3;
  const retryMs = opts.busyRetryMs ?? 700;
  let repo: Repository | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const closeRepo = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const r = repo as (Repository & { close?: () => Promise<void> }) | null;
    repo = null;
    await r?.close?.().catch(() => {});
  };

  const openRepo = async (): Promise<Repository> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await opts.open();
        await ensureTenant(r, opts.tenantId);
        return r;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (!LOCKED.test(msg)) throw e;
        if (attempt >= retries) throw new StoreBusyError(busyMessage(msg, opts.dataDir));
        await new Promise((res) => setTimeout(res, retryMs));
      }
    }
  };

  const run = async <T>(fn: (repo: Repository) => Promise<T>): Promise<T> => {
    if (timer) clearTimeout(timer);
    timer = null;
    repo ??= await openRepo();
    try {
      return await fn(repo);
    } finally {
      if (idleMs != null) {
        timer = setTimeout(() => {
          // closing goes through the queue, so it never pulls the store from under a call
          chain = chain.then(closeRepo, closeRepo);
        }, idleMs);
        timer.unref?.();
      }
    }
  };

  return {
    withRepo<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
      const next = chain.then(
        () => run(fn),
        () => run(fn),
      );
      chain = next.catch(() => undefined);
      return next;
    },
    async close() {
      await chain.catch(() => undefined);
      await closeRepo();
    },
    get isOpen() {
      return repo != null;
    },
  };
}

/** A repository the caller owns (tests, an embedding app): used as-is, never closed here. */
export function sharedRepo(repo: Repository, tenantId: string): RepoAccess {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    withRepo<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
      const next = chain.then(async () => {
        await ensureTenant(repo, tenantId);
        return fn(repo);
      });
      chain = next.catch(() => undefined);
      return next;
    },
    async close() {
      await chain.catch(() => undefined);
    },
    isOpen: true,
  };
}

function busyMessage(raw: string, dataDir?: string): string {
  const pid = raw.match(/pid (\d+)/)?.[1];
  let server: { pid?: number; url?: string } | null = null;
  if (dataDir) {
    try {
      server = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { pid?: number; url?: string };
    } catch {
      server = null;
    }
  }
  const who =
    server?.url && (!pid || String(server.pid) === pid)
      ? `the JobFlow web app (\`jobflow serve\`, ${server.url}, pid ${server.pid})`
      : `another process${pid ? ` (pid ${pid})` : ""} — usually \`jobflow serve\` / \`pnpm web\` or a long \`jobflow sync\``;
  return (
    `JobFlow's local database${dataDir ? ` (${dataDir})` : ""} is open in ${who}. ` +
    "It is single-writer, so this tool can't use it right now. To fix: stop the web app (Ctrl-C in its terminal) " +
    "or wait for the other command to finish, then try again. For running the web app and an AI agent at the same time, " +
    "use Postgres instead: set DATABASE_URL for both (see docs/guides/self-hosting.md). " +
    "If no JobFlow process is running, delete the stale .lock file in the data dir."
  );
}
