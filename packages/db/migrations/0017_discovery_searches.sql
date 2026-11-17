-- Saved searches + configurable discovery + company follows (docs/internal/PRODUCT_PLAN.md).
--  * saved_search — a tenant's named SearchQuery, used as a source query (cron) and/or a
--    feed view. Views hide only confidently-known values and never change a score
--    (invariant #4). Names are unique per tenant, case-insensitively.
--  * discovery_source — a tenant's custom feed (RSS/JSON/Telegram/HN/company list).
--    config_key = hash of the normalized config: unique per tenant, and indexed so the
--    cron fetches a source shared by many tenants once. Postings found stay GLOBAL.
--  * company_follow — tenant overlay on the global company registry.
--  * tenant_config.discovery_preset / preset_feeds_disabled — which built-in preset
--    (`india` = today's behaviour, the default for existing installs) and which of its
--    feeds this tenant switched off.
--  * company.poll_markets — ISO-2 markets a multi-country board is polled for (null = default).
-- Idempotent: safe to re-run.

create table if not exists saved_search (
  id           uuid primary key default uuid_generate_v4(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  name         text not null,
  query        jsonb not null default '{}',
  as_source    boolean not null default true,
  as_view      boolean not null default true,
  cadence      text not null default 'daily',     -- daily | weekly | manual
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_result  jsonb,
  created_at   timestamptz not null default now()
);
create unique index if not exists saved_search_name_idx on saved_search (tenant_id, lower(name));
create index if not exists saved_search_source_idx on saved_search (enabled, as_source);

create table if not exists discovery_source (
  id           uuid primary key default uuid_generate_v4(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  label        text not null default '',
  config       jsonb not null,
  config_key   text not null,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_status  text,                               -- ok | empty | error
  last_count   int,
  last_error   text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, config_key)
);
create index if not exists discovery_source_key_idx on discovery_source (config_key);

create table if not exists company_follow (
  tenant_id   uuid not null references tenant(id) on delete cascade,
  company_id  uuid not null references company(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, company_id)
);

alter table tenant_config
  add column if not exists discovery_preset      text   not null default 'india',
  add column if not exists preset_feeds_disabled text[] not null default '{}';

alter table company add column if not exists poll_markets text[];

-- RLS (same pattern as 0002/0003/0007). Service role (web server, worker, agent) bypasses.
do $$
declare t text;
begin
  foreach t in array array['saved_search','discovery_source','company_follow']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format($f$
        create policy %1$s_tenant on %1$s
          using (tenant_id = public.current_tenant())
          with check (tenant_id = public.current_tenant())
      $f$, t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
