import "server-only";
import { createRepository, defaultDataDir, storeKind, type Repository } from "@jobflow/db";
import {
  ensureTenant as ensureTenantFor,
  operatorJobCtx,
  rankTenant,
  seedDemoCorpus,
  startCloudJobDrainer,
  startCorpusSync,
  type CloudJobDrainer,
} from "@jobflow/service";
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
        else {
          scheduleLocalSync(repo);
          startLocalJobRunner(repo);
        }
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
  if (scheduled || !isLocalMode()) return;
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

/** True when this server is the only process on its store (local-first, single user). */
function isLocalMode(): boolean {
  return process.env.JOBFLOW_AUTH !== "password" && !process.env.DATABASE_URL;
}

/**
 * Run queued CLOUD jobs in-process (Sources → Maintenance: recheck, retire old, Discover,
 * Poll, Re-rank, Enrich comp…). On the local store the web server holds the single-writer
 * database, so the worker can't run beside it — without this those buttons queued work
 * that never ran. One job at a time; idle it costs one claim query every few seconds.
 * Only runtime='cloud' jobs are ever claimed: LOCAL jobs (tier-3, form_fill, local board
 * polls) stay queued for the local agent (invariant #1). Hosted / Postgres deployments
 * leave this to the worker.
 */
let jobRunner: CloudJobDrainer | null = null;
function startLocalJobRunner(repo: Repository): void {
  if (jobRunner || !isLocalMode()) return;
  jobRunner = startCloudJobDrainer(repo, operatorJobCtx, {
    log: (m) => console.log(`[jobflow] job ${m}`),
  });
}

/** Check the job queue now (after enqueueing) instead of at the drainer's next tick. */
export function wakeJobRunner(): void {
  jobRunner?.wake();
}

/** Ensure the tenant's profile + config exist (blank profile; sample only on request). */
export async function ensureTenant(repo: Repository, tenantId: string): Promise<void> {
  await ensureTenantFor(repo, tenantId);
}
