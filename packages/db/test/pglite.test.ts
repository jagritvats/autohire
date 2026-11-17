import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrations.js";
import { acquireDataDirLock } from "../src/paths.js";
import { openPglite } from "../src/pglite.js";
import { createRepository, isDurable, storeKind } from "../src/factory.js";
import { PgRepository } from "../src/postgres.js";
import { InMemoryRepository } from "../src/memory.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "jobflow-pglite-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

describe("migrations on PGlite", () => {
  it("applies every migration 0001…latest cleanly, then re-runs as a no-op after reopening", async () => {
    expect(ALL[0]).toBe("0001_init.sql");
    expect(ALL).toContain("0017_discovery_searches.sql");
    const dir = tempDir();

    const db = await openPglite(dir);
    const { rows } = await db.query<{ name: string }>("select name from _migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(ALL);
    // the tables + columns the new migrations add exist
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where (table_name, column_name) in (('app_user','email'),('auth_session','secret_hash'),('api_token','scopes'),
         ('tenant','last_active_at'),('tenant_config','llm_api_key_enc'),('posting','contributed_by'),
         ('profile','onboarded_at'),('profile','resume_file'),('evidence','origin'),('saved_search','query'),
         ('discovery_source','config_key'),('company_follow','company_id'),('tenant_config','discovery_preset'),
         ('tenant_config','preset_feeds_disabled'),('company','poll_markets'),('agent_heartbeat','token_id'))`,
    );
    expect(cols.rows).toHaveLength(16);
    // the seeded default tenant gets the india preset (existing installs keep today's behaviour)
    const cfg = await db.query("select discovery_preset from tenant_config where tenant_id = '00000000-0000-0000-0000-000000000001'");
    expect(cfg.rows[0]?.discovery_preset).toBe("india");
    await db.close();

    // data survives a reopen, and nothing is re-applied
    const again = await openPglite(dir, { migrate: false });
    const res = await runMigrations(again);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(ALL);
    await again.close();
  }, 120_000);

  it("backfills onboarded_at for profiles that already have a résumé (0016)", async () => {
    const dir = tempDir();
    const db = await openPglite(dir, { migrate: false });
    // apply up to 0015, insert legacy rows, then apply the rest
    const upTo = join(dir, "mig-old");
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(upTo);
    for (const f of ALL.filter((f) => f < "0016")) copyFileSync(join(MIGRATIONS_DIR, f), join(upTo, f));
    await runMigrations(db, upTo);
    const T = "00000000-0000-0000-0000-000000000001";
    await db.query("insert into tenant (id, name) values ($1, 'b') ", ["00000000-0000-0000-0000-0000000000b2"]);
    await db.query("insert into profile (tenant_id, master_resume) values ($1, 'my resume')", [T]);
    await db.query("insert into profile (tenant_id, master_resume) values ($1, '')", ["00000000-0000-0000-0000-0000000000b2"]);
    await runMigrations(db);
    const { rows } = await db.query("select tenant_id, onboarded_at from profile order by tenant_id");
    expect(rows[0]?.onboarded_at).not.toBeNull();
    expect(rows[1]?.onboarded_at).toBeNull();
    await db.close();
  }, 120_000);
});

describe("single-writer data dir lock", () => {
  it("refuses a second open of the same dir and releases on close", async () => {
    const dir = tempDir();
    const db = await openPglite(dir);
    await expect(openPglite(dir)).rejects.toThrow(/already open in this process/);
    await db.close();
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    const reopened = await openPglite(dir, { migrate: false });
    await reopened.close();
  }, 120_000);

  it("refuses a dir held by another live process, takes over a dead one's lock", () => {
    const dir = tempDir();
    // another live pid on this host: our parent (vitest's runner / shell)
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: "then" }));
    expect(() => acquireDataDirLock(dir)).toThrow(/in use by another process \(pid \d+/);

    // a pid that has exited → stale → taken over
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: Number(dead), host: hostname(), startedAt: "then" }));
    const lock = acquireDataDirLock(dir);
    expect(statSync(lock.path).mode & 0o777).toBe(0o600);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });
});

describe("createRepository / storeKind", () => {
  it("resolves the store: explicit → DATABASE_URL → JOBFLOW_STORE → JOBFLOW_DATA_DIR → memory", () => {
    expect(storeKind({}, {})).toBe("memory");
    expect(storeKind({}, { JOBFLOW_DATA_DIR: "/x" })).toBe("pglite");
    expect(storeKind({}, { JOBFLOW_STORE: "memory", JOBFLOW_DATA_DIR: "/x" })).toBe("memory");
    expect(storeKind({}, { JOBFLOW_STORE: "pglite" })).toBe("pglite");
    expect(storeKind({}, { DATABASE_URL: "postgres://x", JOBFLOW_STORE: "pglite" })).toBe("postgres");
    expect(storeKind({ store: "memory" }, { DATABASE_URL: "postgres://x" })).toBe("memory");
    expect(() => storeKind({}, { JOBFLOW_STORE: "sqlite" })).toThrow(/JOBFLOW_STORE/);
  });

  it("defaults to in-memory with no env, and opens a durable PGlite repo on request", async () => {
    const saved = { url: process.env.DATABASE_URL, store: process.env.JOBFLOW_STORE, dir: process.env.JOBFLOW_DATA_DIR };
    delete process.env.DATABASE_URL;
    delete process.env.JOBFLOW_STORE;
    delete process.env.JOBFLOW_DATA_DIR;
    try {
      expect(isDurable()).toBe(false);
      expect(await createRepository()).toBeInstanceOf(InMemoryRepository);

      const dir = join(tempDir(), "nested", "data");
      const repo = await createRepository({ store: "pglite", dataDir: dir });
      expect(repo).toBeInstanceOf(PgRepository);
      expect((repo as PgRepository).kind).toBe("pglite");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "pgdata")).mode & 0o777).toBe(0o700);
      const t = await repo.createTenant({ name: "durable" });
      await (repo as PgRepository).close();

      const back = (await createRepository({ store: "pglite", dataDir: dir })) as PgRepository;
      expect((await back.getTenant(t.id))?.name).toBe("durable");
      await back.close();
    } finally {
      for (const [k, v] of [["DATABASE_URL", saved.url], ["JOBFLOW_STORE", saved.store], ["JOBFLOW_DATA_DIR", saved.dir]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 120_000);
});
