import "server-only";
import { createRepository, defaultDataDir, storeKind, type Repository } from "@jobflow/db";
import { ensureTenant as ensureTenantFor, rankTenant, seedDemoCorpus, startCorpusSync } from "@jobflow/service";
import { DEFAULT_TENANT_ID } from "./tenant-constant";

/**
 * One repository per server process.
 *
 * Local-first default: with nothing configured, the web app uses the SAME durable store as
 * the CLI — PGlite under ~/.jobflow (JOBFLOW_DATA_DIR) — so scans, your profile and your
 * applications survive restarts and `jobflow` and the web app see one database. In-memory
 * is only used when asked for (JOBFLOW_STORE=memory, e.g. demo/screenshots); DATABASE_URL
 * (Docker, hosting) wins over both.
 */
let repoPromise: Promise<Repository> | null = null;

export function getRepo(): Promise<Repository> {
  if (!repoPromise) {
    const explicit = !!process.env.DATABASE_URL || !!process.env.JOBFLOW_STORE?.trim();
    const store = explicit ? undefined : storeKind() === "memory" ? ("pglite" as const) : undefined;
    repoPromise = createRepository(store ? { store } : {})
      .then(async (repo) => {
        // JOBFLOW_DEMO_DATA=1: an offline, fully fictional corpus (screenshots / UI dev)
        if (process.env.JOBFLOW_DEMO_DATA === "1") await seedDemoCorpus(repo, DEFAULT_TENANT_ID);
        else scheduleLocalSync(repo);
        return repo;
      })
      .catch((e: unknown) => {
        repoPromise = null; // let the next request retry (e.g. after the CLI releases the lock)
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          /single-writer|in use by another process|locked by pid/.test(msg)
            ? `Your JobFlow data (${process.env.JOBFLOW_DATA_DIR || defaultDataDir()}) is open in another process — ` +
                "the local database takes one writer at a time. Close the other `jobflow` command or web server and reload. " +
                `(${msg})`
            : msg,
        );
      });
  }
  return repoPromise;
}

/**
 * Keep the feed fresh while the app is open. On the local store the database is
 * single-writer, so a separate worker process can't share it — the web server runs the
 * same discover → poll → rank schedule itself (JOBFLOW_POLL_EVERY_HOURS, default 6; 0 = off).
 * Multi-user / Postgres deployments use the worker instead.
 */
let scheduled = false;
function scheduleLocalSync(repo: Repository): void {
  if (scheduled || process.env.JOBFLOW_AUTH === "password" || process.env.DATABASE_URL) return;
  const hours = Number(process.env.JOBFLOW_POLL_EVERY_HOURS?.trim() || 6);
  if (!(hours > 0)) return;
  scheduled = true;
  const tick = async () => {
    try {
      const companies = await repo.listCompanies();
      const last = Math.max(0, ...companies.map((c) => (c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0)));
      // never synced → the first visit's background sync handles it; otherwise only when due
      if (last > 0 && Date.now() - last >= hours * 3_600_000) {
        void startCorpusSync(repo, async () => void (await rankTenant(repo, DEFAULT_TENANT_ID)));
      }
    } catch {
      /* best effort — the next tick retries */
    }
  };
  setInterval(() => void tick(), 15 * 60_000).unref?.();
}

/** Ensure the tenant's profile + config exist (blank profile; sample only on request). */
export async function ensureTenant(repo: Repository, tenantId: string): Promise<void> {
  await ensureTenantFor(repo, tenantId);
}
