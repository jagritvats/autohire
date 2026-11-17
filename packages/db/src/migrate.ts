import { loadRootEnv } from "./env.js";
import { storeKind } from "./factory.js";
import { MIGRATIONS_DIR, runMigrations } from "./migrations.js";
import { defaultDataDir } from "./paths.js";
import type { SqlClient } from "./sql.js";

loadRootEnv();

/**
 * Apply pending migrations (forward-only, tracked in `_migrations`, idempotent):
 *   DATABASE_URL=...           pnpm --filter @jobflow/db migrate   # Postgres / Supabase
 *   JOBFLOW_STORE=pglite       pnpm --filter @jobflow/db migrate   # local PGlite (~/.jobflow)
 */
async function main(): Promise<void> {
  const kind = storeKind();
  let client: SqlClient;
  if (kind === "postgres") {
    const { pgPoolClient } = await import("./sql.js");
    client = pgPoolClient(process.env.DATABASE_URL, { max: 1 });
  } else if (kind === "pglite") {
    const dir = defaultDataDir();
    console.log(`PGlite data dir: ${dir}`);
    const { openPglite } = await import("./pglite.js");
    client = await openPglite(dir, { migrate: false });
  } else {
    console.error("DATABASE_URL not set — nothing to migrate (the in-memory repo needs no migration; JOBFLOW_STORE=pglite for the local store).");
    process.exit(1);
  }
  try {
    await runMigrations(client, MIGRATIONS_DIR, (l) => console.log(l));
    console.log("migrations up to date.");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
