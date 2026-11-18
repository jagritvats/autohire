import type { Repository } from "./repository.js";
import { InMemoryRepository } from "./memory.js";
import { defaultDataDir } from "./paths.js";

export type StoreKind = "memory" | "pglite" | "postgres";
const KINDS: readonly StoreKind[] = ["memory", "pglite", "postgres"];

export interface RepositoryOptions {
  /** force a store; otherwise resolved from the environment (see `storeKind`). */
  store?: StoreKind;
  /** PGlite data dir (default `$JOBFLOW_DATA_DIR`, else `~/.jobflow`). Does not pick the store. */
  dataDir?: string;
  /** Postgres URL (default `DATABASE_URL`). */
  databaseUrl?: string;
}

/**
 * Which store `createRepository` opens. Precedence:
 *   explicit `store` → DATABASE_URL (Postgres) → JOBFLOW_STORE → JOBFLOW_DATA_DIR set (PGlite)
 *   → in-memory.
 * The library default stays in-memory (tests, embedding); the APPS choose durability: the CLI
 * and the web app (apps/web/lib/repo.ts) ask for PGlite in ~/.jobflow when nothing is
 * configured, so they share one store. A hosted DB always wins.
 */
export function storeKind(opts: RepositoryOptions = {}, env: NodeJS.ProcessEnv = process.env): StoreKind {
  if (opts.store) return check(opts.store, "store option");
  if (opts.databaseUrl || env.DATABASE_URL) return "postgres";
  const fromEnv = env.JOBFLOW_STORE?.trim().toLowerCase();
  if (fromEnv) return check(fromEnv, "JOBFLOW_STORE");
  if (env.JOBFLOW_DATA_DIR?.trim()) return "pglite";
  return "memory";
}

function check(v: string, where: string): StoreKind {
  if ((KINDS as readonly string[]).includes(v)) return v as StoreKind;
  throw new Error(`${where} must be one of ${KINDS.join(" | ")} (got "${v}")`);
}

/** true when data outlives the process (Postgres or PGlite). */
export function isDurable(opts?: RepositoryOptions): boolean {
  return storeKind(opts) !== "memory";
}

/**
 * Compose the repository everything shares — callers depend only on `Repository`.
 * Postgres and PGlite both run `PgRepository` (same SQL + migrations); PGlite migrates
 * on open and holds a single-writer lock on its data dir until the repo is closed.
 * Drivers are imported lazily so bundles that only need the in-memory repo never load them.
 */
export async function createRepository(opts: RepositoryOptions = {}): Promise<Repository> {
  const kind = storeKind(opts);
  if (kind === "postgres") {
    const url = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error("store=postgres needs DATABASE_URL");
    const { PgRepository } = await import("./postgres.js");
    return new PgRepository(url);
  }
  if (kind === "pglite") {
    const [{ PgRepository }, { openPglite }] = await Promise.all([import("./postgres.js"), import("./pglite.js")]);
    return new PgRepository(await openPglite(opts.dataDir ?? defaultDataDir()));
  }
  return new InMemoryRepository();
}
