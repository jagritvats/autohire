-- Connected context (§ Customize). Read-only profile imports — GitHub repos, a
-- LinkedIn data-export, a YC/Work-at-a-Startup profile — fed to generation as
-- attributed *background* (never merged into the Evidence Bank or stack, so the
-- Evidence Bank stays the citeable spine, invariant #3). One row per (tenant, source).
-- Tier boundary (invariant #1): GitHub is fetched server-side (Tier 1); LinkedIn is a
-- file the user uploads (no scraping); YC is auth-gated → the LOCAL agent imports it
-- (import_yc job) or the user pastes it. The cloud never holds a LinkedIn/YC session.

create table if not exists connected_context (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  source      text not null,            -- github | linkedin | yc | manual
  handle      text not null default '',
  label       text not null default '',
  content     text not null default '',
  items       jsonb not null default '[]',
  enabled     boolean not null default true,
  synced_at   timestamptz not null default now(),
  unique (tenant_id, source)
);
create index if not exists connected_context_tenant_idx on connected_context (tenant_id);

-- RLS (same pattern as 0002/0003/0005). Service role (worker + agent) bypasses.
alter table connected_context enable row level security;
do $$ begin
  create policy connected_context_tenant on connected_context
    using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());
exception when duplicate_object then null; end $$;
