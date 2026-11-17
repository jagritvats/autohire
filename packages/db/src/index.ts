export * from "./repository.js";
export { InMemoryRepository } from "./memory.js";
export { createRepository, isDurable, storeKind, type StoreKind, type RepositoryOptions } from "./factory.js";
export { loadRootEnv, parseDotEnv, loadEnvFile, findWorkspaceRoot } from "./env.js";
export { defaultDataDir, ensurePrivateDir, acquireDataDirLock, type DataDirLock } from "./paths.js";
export { MIGRATIONS_DIR, runMigrations, type MigrationResult } from "./migrations.js";
export type { SqlClient, SqlRow } from "./sql.js";
export { LocalFileStore, createFileStore, safeFileName, type FileStore, type FileKind } from "./files.js";
export {
  hashPassword,
  verifyPassword,
  newSecret,
  newId,
  sha256Hex,
  safeEqualHex,
  encryptSecret,
  decryptSecret,
} from "./auth/crypto.js";
import type { OpenPgliteOptions } from "./pglite.js";
import type { SqlClient } from "./sql.js";
export type { OpenPgliteOptions } from "./pglite.js";

// Drivers (pg, PGlite) and PgRepository load lazily — via createRepository() or the
// wrappers below — so bundles that only need the in-memory repo or the types never pull
// them in. Import "@jobflow/db/postgres" / "@jobflow/db/pglite" for the classes directly.

/** open (and migrate) the embedded PGlite store under `dataDir`. */
export async function openPglite(dataDir: string, opts?: OpenPgliteOptions): Promise<SqlClient> {
  return (await import("./pglite.js")).openPglite(dataDir, opts);
}

/** a node-postgres pool as a SqlClient (TLS from `sslmode` / PGSSLMODE). */
export async function openPostgres(url = process.env.DATABASE_URL): Promise<SqlClient> {
  return (await import("./sql.js")).pgPoolClient(url);
}
