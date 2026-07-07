import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRootEnv } from "./env.js";

loadRootEnv();

/**
 * Minimal forward-only migrator. Applies every .sql in migrations/ in name order,
 * once, tracked in a _migrations table. Idempotent to re-run.
 *   DATABASE_URL=... pnpm --filter @jobflow/db migrate
 */
async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set — nothing to migrate (the in-memory repo needs no migration).");
    process.exit(1);
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const client = new pg.Client({
    connectionString: url,
    ssl: /supabase|amazonaws|render|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  await client.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`);
  const { rows } = await client.query<{ name: string }>("select name from _migrations");
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`· skip ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`✓ applied ${file}`);
    } catch (e) {
      await client.query("rollback");
      console.error(`✗ failed ${file}:`, (e as Error).message);
      await client.end();
      process.exit(1);
    }
  }
  await client.end();
  console.log("migrations up to date.");
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
