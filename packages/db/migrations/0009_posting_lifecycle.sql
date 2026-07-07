-- Posting lifecycle + per-user overlay (§3, §5). Two distinct concerns, two homes:
--   • a GLOBAL manual lifecycle on the shared posting (invalidate / stale), alongside
--     the existing is_active freshness flag; and
--   • a TENANT-SCOPED overlay for archive + bookmark — user-scoped state never leaks
--     into the shared registry, mirroring the RLS boundary (invariant: multi-tenant-ready).
-- Idempotent: safe to re-run.

-- ── global lifecycle on the shared posting ──
alter table posting
  add column if not exists status         text not null default 'active',  -- active | invalidated | stale
  add column if not exists invalid_reason text,
  add column if not exists invalidated_at timestamptz;

create index if not exists posting_status_idx on posting (status, is_active);

-- backfill: already soft-deleted (is_active=false) rows are 'stale' so status ⇔ freshness
update posting set status = 'stale' where is_active = false and status = 'active';

-- ── tenant-scoped per-user overlay (archive + bookmark) ──
create table if not exists posting_user_state (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  posting_id    uuid not null references posting(id) on delete cascade,
  archived      boolean not null default false,
  archived_at   timestamptz,
  bookmarked    boolean not null default false,
  bookmarked_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, posting_id)
);
create index if not exists posting_user_state_archived_idx on posting_user_state (tenant_id, archived);
create index if not exists posting_user_state_bookmarked_idx on posting_user_state (tenant_id, bookmarked);

-- RLS (same pattern as 0002/0003/0007). Service role (worker + agent) bypasses.
alter table posting_user_state enable row level security;
do $$ begin
  create policy posting_user_state_tenant on posting_user_state
    using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());
exception when duplicate_object then null; end $$;
