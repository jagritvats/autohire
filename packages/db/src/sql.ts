import pg from "pg";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

/** A result row as the driver returns it (snake_case columns). */
export type SqlRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The tiny SQL surface PgRepository + the migrator need, so the same SQL runs on a
 * real Postgres pool (server / Supabase) and on PGlite (Postgres-in-WASM, the CLI's
 * zero-infra durable store). Parameter placeholders are `$1..$n` on both.
 */
export interface SqlClient {
  readonly kind: "postgres" | "pglite";
  query<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** run one or more statements (no params) — migrations. */
  exec(sql: string): Promise<void>;
  /** run `fn` inside BEGIN/COMMIT on ONE connection (rolled back if it throws). */
  transaction<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

// ── Postgres (node-postgres pool) ──

/**
 * TLS from the libpq `sslmode` (in the URL, else PGSSLMODE) instead of guessing from the
 * host name. `require`/`no-verify` encrypt without verifying the certificate (what
 * managed poolers need without a CA bundle); `verify-ca`/`verify-full` verify against
 * the system CAs; `disable`/`allow`/`prefer`/unset → plain TCP (node-postgres can't
 * negotiate a fallback, so `prefer` can't mean "try TLS first").
 */
export function sslFromMode(mode: string | null | undefined): false | { rejectUnauthorized: boolean } {
  switch ((mode ?? "").trim().toLowerCase()) {
    case "require":
    case "no-verify":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return false;
  }
}

/**
 * Split a DATABASE_URL into the URL node-postgres should parse and the ssl option.
 * `sslmode` is stripped from the URL because pg's own parser would otherwise override
 * the explicit `ssl` option (and treats `require` as `verify-full` in pg ≥ 8.12).
 */
export function pgConnectionConfig(url: string, env: NodeJS.ProcessEnv = process.env): { connectionString: string; ssl: false | { rejectUnauthorized: boolean } } {
  let mode: string | null = null;
  let connectionString = url;
  try {
    const u = new URL(url);
    mode = u.searchParams.get("sslmode");
    if (mode !== null) {
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    }
  } catch {
    // not a URL (e.g. a "host=… dbname=…" keyword string) — leave it to pg
  }
  return { connectionString, ssl: sslFromMode(mode ?? env.PGSSLMODE) };
}

function wrapPg(q: { query: pg.Pool["query"] }, kind: "postgres"): Omit<SqlClient, "transaction" | "close"> {
  return {
    kind,
    async query<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []) {
      const r = await q.query<T>(text, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await q.query(sql); // simple protocol → multi-statement OK
    },
  };
}

export function pgPoolClient(url = process.env.DATABASE_URL, opts: { max?: number } = {}): SqlClient {
  if (!url) throw new Error("a Postgres connection needs DATABASE_URL");
  const pool = new pg.Pool({ ...pgConnectionConfig(url), max: opts.max ?? 8 });
  const base = wrapPg(pool, "postgres");
  return {
    ...base,
    async transaction<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R> {
      const conn = await pool.connect();
      const tx: SqlClient = {
        ...wrapPg(conn, "postgres"),
        transaction: (inner) => inner(tx), // already in one; flat
        close: async () => {},
      };
      try {
        await conn.query("begin");
        const out = await fn(tx);
        await conn.query("commit");
        return out;
      } catch (e) {
        await conn.query("rollback").catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}

// ── PGlite ──

type PgliteLike = Pick<PGliteInterface, "query" | "exec"> | Transaction;

function wrapPglite(db: PgliteLike): Omit<SqlClient, "transaction" | "close"> {
  return {
    kind: "pglite",
    async query<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []) {
      const r = await db.query<T>(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

/** Wrap an open PGlite instance. `onClose` runs after the database closes (lock release). */
export function pgliteClient(db: PGliteInterface, onClose?: () => void | Promise<void>): SqlClient {
  return {
    ...wrapPglite(db),
    transaction<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R> {
      return db.transaction(async (t) => {
        const tx: SqlClient = { ...wrapPglite(t), transaction: (inner) => inner(tx), close: async () => {} };
        return fn(tx);
      });
    },
    async close() {
      try {
        if (!db.closed) await db.close();
      } finally {
        await onClose?.();
      }
    },
  };
}

/** Postgres SQLSTATE of a driver error (pg and PGlite both expose `.code`). */
export function sqlState(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
