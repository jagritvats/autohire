import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./sql.js";

/**
 * packages/db/migrations — resolved from this module, so it works from any cwd.
 * (dirname of import.meta.url rather than `new URL("../migrations/", import.meta.url)`,
 * which webpack would try to bundle as an asset when the web app imports this package.)
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal forward-only migrator. Applies every .sql in `dir` in name order, once,
 * each in its own transaction, tracked in `_migrations`. Idempotent to re-run.
 * The same files run on Postgres/Supabase and on PGlite.
 */
export async function runMigrations(
  client: SqlClient,
  dir = MIGRATIONS_DIR,
  log: (line: string) => void = () => {},
): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await client.exec(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`);
  const { rows } = await client.query<{ name: string }>("select name from _migrations");
  const done = new Set(rows.map((r) => r.name));
  const out: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    if (done.has(file)) {
      out.skipped.push(file);
      log(`· skip ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    try {
      await client.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("insert into _migrations (name) values ($1)", [file]);
      });
    } catch (e) {
      throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
    }
    out.applied.push(file);
    log(`✓ applied ${file}`);
  }
  return out;
}
