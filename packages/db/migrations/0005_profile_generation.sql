-- Profile/About config + cached generation (§4, § "Customize" feature).
-- profile.about_text: the free "about you" narrative (background grounding for
-- generation, alongside master_resume). The generation table is the durable cache
-- for evidence-grounded drafts (resume variants + answers) — keyed per
-- (tenant, posting, kind, prompt); input_hash invalidates a draft when its inputs
-- change. posting_id null = a generic (settings) draft; set = tailored to a posting.

alter table profile
  add column if not exists about_text text not null default '';

create table if not exists generation (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  posting_id  uuid references posting(id) on delete cascade,   -- null = generic
  kind        text not null,            -- resume | why_here | interesting_problem | about_blurb | answer
  prompt      text not null default '', -- question text (free-form answers)
  content     text not null,            -- text; kind='resume' stores JSON of variants
  model       text not null default 'echo',
  input_hash  text not null,            -- sha256 of the inputs → stale-cache detection
  created_at  timestamptz not null default now()
);
create index if not exists generation_slot_idx on generation (tenant_id, posting_id, kind);

-- RLS (same pattern as 0002/0003). Service role (worker + agent) bypasses.
alter table generation enable row level security;
do $$ begin
  create policy generation_tenant on generation
    using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());
exception when duplicate_object then null; end $$;
