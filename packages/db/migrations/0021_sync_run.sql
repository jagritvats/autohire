-- Sync run history: one row per corpus sync (web background sync, `jobflow sync`, the MCP
-- tool, the worker), holding the run's final progress snapshot (the SyncProgress shape in
-- @jobflow/core). Global like `company`/`posting` — the corpus is shared; entries that
-- belong to a tenant's own sources carry their tenant ids inside `summary` and are
-- filtered by the service before anyone sees them. The store keeps the newest 50.
-- Idempotent: safe to re-run.

create table if not exists sync_run (
  id           text primary key,
  trigger      text not null,                 -- manual | scheduled | catch_up | first_run | search
  origin       text not null,                 -- web | cli | mcp | worker
  status       text not null,                 -- running | done | cancelled | failed
  started_at   timestamptz not null,
  finished_at  timestamptz,
  summary      jsonb not null default '{}'
);
create index if not exists sync_run_started_idx on sync_run (started_at desc);

-- RLS like the other shared-global tables (0002): readable, written by the service role.
alter table sync_run enable row level security;
do $$
begin
  create policy sync_run_read on sync_run for select using (true);
exception when duplicate_object then null;
end $$;
