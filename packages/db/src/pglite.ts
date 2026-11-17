import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Extension, PGlite as PGliteClass } from "@electric-sql/pglite";
import { runMigrations, MIGRATIONS_DIR } from "./migrations.js";
import { acquireDataDirLock, ensurePrivateDir } from "./paths.js";
import { pgliteClient, type SqlClient } from "./sql.js";

export interface OpenPgliteOptions {
  /** apply pending migrations after opening (default true). */
  migrate?: boolean;
  migrationsDir?: string;
  log?: (line: string) => void;
}

/**
 * Open (creating if needed) the zero-infra durable store: Postgres-in-WASM under
 * `<dataDir>/pgdata`, running the SAME migrations + SQL as the server. Takes the
 * single-writer lock on `dataDir` (released on close). `dataDir = "memory://"` opens an
 * ephemeral in-memory database (tests) with no lock.
 *
 * Extensions: 0001 creates `pg_trgm` and `uuid-ossp`, both shipped as PGlite contrib
 * modules; pgvector is only on the commented-out scale path, so nothing else is needed.
 */
export async function openPglite(dataDir: string, opts: OpenPgliteOptions = {}): Promise<SqlClient> {
  const memory = dataDir === "memory://";
  const lock = memory ? null : acquireDataDirLock(dataDir);
  let client: SqlClient | null = null;
  try {
    const { PGlite, pg_trgm, uuid_ossp } = await loadPglite();
    const pgDir = memory ? undefined : ensurePrivateDir(join(dataDir, "pgdata"));
    const db = await PGlite.create({ ...(pgDir ? { dataDir: pgDir } : {}), extensions: { pg_trgm, uuid_ossp } });
    client = pgliteClient(db, () => lock?.release());
    if (opts.migrate !== false) await runMigrations(client, opts.migrationsDir ?? MIGRATIONS_DIR, opts.log);
    return client;
  } catch (e) {
    if (client) await client.close().catch(() => {});
    else lock?.release();
    throw e;
  }
}

interface PgliteModules {
  PGlite: typeof PGliteClass;
  pg_trgm: Extension;
  uuid_ossp: Extension;
}

/**
 * Load PGlite with Node's own `import()`, never through a bundler: PGlite locates its wasm,
 * fs bundle and extension tarballs via `new URL(…, import.meta.url)`, which a bundler (Next's
 * webpack, for the web app) rewrites into asset URLs that don't exist at runtime. In the
 * monorepo the package sits next to this source (webpack keeps `import.meta.url` pointing at
 * the source file), so import it by absolute file URL; elsewhere resolve it normally.
 */
async function loadPglite(): Promise<PgliteModules> {
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@electric-sql", "pglite", "dist");
  const local = existsSync(join(dist, "index.js")) && existsSync(join(dist, "contrib", "pg_trgm.js"));
  const spec = (sub: string, bare: string) => (local ? pathToFileURL(join(dist, sub)).href : bare);
  const [core, trgm, uuid] = await Promise.all([
    import(/* webpackIgnore: true */ /* @vite-ignore */ spec("index.js", "@electric-sql/pglite")),
    import(/* webpackIgnore: true */ /* @vite-ignore */ spec("contrib/pg_trgm.js", "@electric-sql/pglite/contrib/pg_trgm")),
    import(/* webpackIgnore: true */ /* @vite-ignore */ spec("contrib/uuid_ossp.js", "@electric-sql/pglite/contrib/uuid_ossp")),
  ]);
  return { PGlite: core.PGlite, pg_trgm: trgm.pg_trgm, uuid_ossp: uuid.uuid_ossp };
}
