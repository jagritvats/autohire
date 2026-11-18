# Data, storage and migrations

Everything JobFlow stores goes through one interface, `Repository`
(`packages/db/src/repository.ts`). Three stores implement it, and one test suite holds them
to the same behaviour. This guide covers how storage is chosen, how to add a field or a
table, and the tenant-isolation rules every change must keep.

## The stores

| Store | Class | Used by | Notes |
|---|---|---|---|
| in-memory | `InMemoryRepository` (`packages/db/src/memory.ts`) | tests, `--store memory`, demo mode | nothing persists |
| PGlite | `PgRepository` over PGlite (`packages/db/src/pglite.ts`) | the CLI and web app by default, under `~/.jobflow` or `JOBFLOW_DATA_DIR` | Postgres compiled to WASM; single writer |
| Postgres | `PgRepository` over a `pg` pool (`packages/db/src/postgres.ts`, `packages/db/src/sql.ts`) | Docker, hosting, the worker | `DATABASE_URL`; TLS follows `sslmode` |

PGlite and Postgres run the **same** `PgRepository`, SQL and migrations through the
`SqlClient` abstraction in `packages/db/src/sql.ts`. There is no third SQL dialect.

`createRepository()` (`packages/db/src/factory.ts`) picks the store: an explicit `store`
option, then `DATABASE_URL`, then `JOBFLOW_STORE`, then PGlite if `JOBFLOW_DATA_DIR` is set,
else in-memory. The apps choose a durable default on top of that: the CLI's `Ctx` defaults
to PGlite, and the web app's `getRepo()` (`apps/web/lib/repo.ts`) opens PGlite unless
`JOBFLOW_STORE` or `DATABASE_URL` says otherwise.

Drivers load lazily, so a bundle that only needs the in-memory repo never pulls in `pg` or
PGlite.

### PGlite is single-writer

Opening PGlite takes a lock file (`<data dir>/.lock`, `acquireDataDirLock` in
`packages/db/src/paths.ts`). A second process gets a clear error instead of corrupting the
database. That is why:

- `jobflow serve` holds the data dir, and other `jobflow` commands that write say so;
- the web app runs the sync schedule itself on the local store instead of a separate worker;
- concurrent processes (web plus worker plus agent) need Postgres.

A lock left by a dead process on the same host is taken over automatically. During
development, give each experiment its own `JOBFLOW_DATA_DIR` so you never lock or touch your
real data.

### The file store

Uploaded résumés and tailored outputs are files, not rows. `LocalFileStore`
(`packages/db/src/files.ts`) keeps them under `<data dir>/files/tenants/<tenant>/<kind>/`,
with owner-only permissions. The repository stores only the `StoredFile` key and metadata.
Keys are validated against a strict pattern, so a key can't escape the root. The data dir
is never inside the repo tree, so personal files can't be committed by accident.

## Adding a field or a table

1. **Schema.** Add the field to the Zod shape in `packages/core/src/schema/` (invariant #6:
   one type system). Give it a `.default()` so old rows and old callers still parse.
2. **Migration.** Add the next numbered file in `packages/db/migrations/`
   (`0019_<what>.sql` after `0018_multi_presets.sql`). Start it with a comment that says why.
   Migrations are forward-only and **must be idempotent**: `create table if not exists`,
   `add column if not exists`, `create index if not exists`, and policies created in a
   `do $$ … exception when duplicate_object` block. They run on Postgres, Supabase and PGlite
   alike, so stick to SQL all three accept (PGlite ships `pg_trgm` and `uuid-ossp`).
3. **RLS for tenant tables.** A table with a `tenant_id` gets row-level security with the
   `current_tenant()` policy. Copy the loop at the end of
   `packages/db/migrations/0017_discovery_searches.sql`. Shared global tables (companies,
   postings) are readable by everyone.
4. **Both implementations.** Implement the change in `InMemoryRepository` **and**
   `PgRepository`. Add any new method to the `Repository` interface.
5. **Contract test.** Extend `packages/db/test/contract.test.ts`. It runs every case against
   the in-memory store and against PGlite, so the two can't drift. Test round-tripping,
   idempotency and tenant isolation.
6. Run `pnpm --filter @jobflow/db test`. `packages/db/test/pglite.test.ts` checks that every
   migration applies cleanly from 0001 and re-runs as a no-op.

Migrations apply themselves when PGlite opens. For a Postgres server run them explicitly:

```bash
DATABASE_URL=postgres://… pnpm db:migrate
JOBFLOW_STORE=pglite pnpm db:migrate        # the local store, without opening the app
```

### Postings: idempotent upserts

Postings are a shared, global corpus keyed on `(atsType, atsJobId)` (non-ATS sources use
`scopedJobId`). Re-polling upserts and bumps `lastSeen`. The stored `postedAt` keeps the
**earliest** date seen (`least()` in SQL), because boards re-stamp reposts. Disappeared
board postings are soft-deleted by `markStale`, which must only ever be given the **full**
board. Never add a path that inserts postings without the upsert. See invariant #5 in
[CLAUDE.md](../../CLAUDE.md).

## Tenant isolation

JobFlow can host several people (`JOBFLOW_AUTH=password`). Postings and companies are
shared. Everything else (profile, evidence, config, matches, drafts, applications, saved
searches, sources, tokens) belongs to one tenant.

- **Every tenant-scoped `Repository` method takes the caller's `tenantId`**, and the
  implementation filters by it. Service functions take `(repo, tenantId, …)` and pass it
  through.
- **Web routes get the tenant from the caller.** `guard(req)` or `withAuth(handler)`
  (`apps/web/lib/auth/require.ts`) resolves the session or API token and returns
  `auth.tenantId`. Server pages use `pageAuth()`. Web code never uses `DEFAULT_TENANT`.
- **`scripts/check-tenant.mjs`** enforces both rules in CI: every route under
  `apps/web/app/api/` must call `guard`, `withAuth` or `requireAuth` (except the public
  signup, login and logout routes), and web code may not mention `DEFAULT_TENANT` outside
  the auth resolver. Run it with `node scripts/check-tenant.mjs`.
- **Instance-wide jobs** (discover, poll, liveness, purge) run under the system tenant in
  `packages/pipeline` and the worker. Admin-only web actions pass `{ admin: true }` to
  `guard`.
- **RLS is defence in depth**, for direct database access with a JWT. The web server, worker
  and agent connect as the service role, which bypasses RLS, so the `tenantId` parameter is
  the boundary that actually protects users. Don't rely on RLS alone.
- **Contract tests** check that one tenant can't read, update or delete another's rows
  (profiles, evidence, tokens, saved searches, discovery sources…). Add such a case for any
  new tenant table.
- **No built-in persona.** New tenants start from `blankProfile()`
  (`packages/pipeline/src/seed.ts`). The fictional `sampleProfile()`
  (`packages/pipeline/src/sample.ts`) is only for demos, tests and screenshots.

Cross-tenant access is a security bug. Report it privately ([SECURITY.md](../../SECURITY.md)).
