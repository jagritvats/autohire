-- Command plane (§ IMPLEMENTATION_PLAN Phase 2/4). The web enqueues jobs; the
-- cloud worker drains runtime='cloud' (Tier 1-2), the local agent drains
-- runtime='local' (Tier 3 + form-fill). Communication is ONLY through this table —
-- the cloud never opens a connection into your machine, never holds a session.

create table if not exists job (
  id           uuid primary key default uuid_generate_v4(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  type         text not null,            -- poll | rank | enrich_t1 | discover | tier3_poll | enrich_t3 | form_fill
  runtime      text not null,            -- 'cloud' | 'local'
  payload      jsonb not null default '{}',
  status       text not null default 'queued',  -- queued | running | done | error | canceled
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  picked_at    timestamptz,
  finished_at  timestamptz
);
create index if not exists job_drain_idx on job (runtime, status, created_at);
create index if not exists job_tenant_idx on job (tenant_id, created_at desc);

create table if not exists agent_heartbeat (
  tenant_id        uuid primary key references tenant(id) on delete cascade,
  last_seen        timestamptz not null default now(),
  version          text,
  flags            jsonb not null default '{}',
  enabled_sources  text[] not null default '{}'
);

-- RLS (same pattern as 0002). Service role (worker + agent) bypasses.
alter table job enable row level security;
alter table agent_heartbeat enable row level security;
do $$ begin
  create policy job_tenant on job
    using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());
  create policy agent_tenant on agent_heartbeat
    using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());
exception when duplicate_object then null; end $$;
