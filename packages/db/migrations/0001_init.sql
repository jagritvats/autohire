-- JobFlow schema — multi-tenant from day one (§5, §6.1).
-- Shared-global tables (company, posting, stack_edge) have NO tenant_id: the
-- registry is the same for everyone. Tenant-scoped tables carry tenant_id + RLS.

create extension if not exists vector;       -- pgvector
create extension if not exists pg_trgm;      -- fuzzy company/title matching
create extension if not exists "uuid-ossp";

-- ─────────────────────────── tenancy ───────────────────────────
create table tenant (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table tenant_config (
  tenant_id        uuid primary key references tenant(id) on delete cascade,
  sources_enabled  text[] not null default '{greenhouse,lever,ashby,workable,remotive,arbeitnow,hn_whoishiring}',
  salary_floor     numeric not null default 0,
  currency         text not null default 'INR',
  location_weights jsonb not null default '[]',
  stack_profile    jsonb not null default '{}',
  automation_flags jsonb not null default '{"browser":"off","mode":"capture","autosubmit":false,"rate":"human","tier3_sources":[]}',
  llm_choice       text not null default 'echo',
  digest_cadence   text not null default 'daily'
);

-- ─────────────────────── shared-global data ────────────────────
create table company (
  id                   uuid primary key default uuid_generate_v4(),
  name                 text not null,
  name_norm            text not null unique,
  ats_type             text not null default 'unknown',
  ats_slug             text,
  careers_url          text,
  funding_stage        text,
  tags                 text[] not null default '{}',
  poll_cadence         text not null default 'weekly',
  last_polled          timestamptz,
  status               text not null default 'active',
  rating_overall       numeric,
  rating_wlb           numeric,
  rating_comp          numeric,
  review_count         int,
  rating_source        text,
  culture_summary      text,
  interview_difficulty text,
  created_at           timestamptz not null default now()
);
create index company_name_trgm on company using gin (name gin_trgm_ops);
create index company_due_idx on company (status, last_polled);

create table posting (
  id              uuid primary key default uuid_generate_v4(),
  company_id      uuid not null references company(id) on delete cascade,
  company_name    text not null,
  ats_type        text not null default 'unknown',
  ats_job_id      text not null,
  source          text not null,
  tier            text not null,
  title           text not null,
  title_norm      text not null,
  role_archetype  text not null default 'other',
  level_band      text,
  jd_text         text not null default '',
  jd_skills       text[] not null default '{}',
  requirements    jsonb not null default '[]',
  loc_mode        text not null default 'unknown',
  loc_city        text,
  loc_country     text,
  loc_tz          text,
  remote_geo      text not null default 'unknown',
  sponsorship     boolean,
  salary_min      numeric,
  salary_max      numeric,
  currency        text not null default 'USD',
  salary_source   text not null default 'none',
  salary_confidence text not null default 'low',
  jd_embedding    vector(1536),
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  is_active       boolean not null default true,
  repost_count    int not null default 0,
  canonical_id    uuid references posting(id),
  dedup_key       text not null,
  unique (ats_type, ats_job_id)            -- idempotency key (§3)
);
create index posting_dedup_idx on posting (dedup_key);
create index posting_active_idx on posting (is_active, last_seen desc);
-- approximate-NN index for embedding similarity (matcher + dedup stage-2)
create index posting_embedding_idx on posting using hnsw (jd_embedding vector_cosine_ops);

create table stack_edge (
  from_skill      text not null,
  to_skill        text not null,
  transfer_weight numeric not null,
  primary key (from_skill, to_skill)
);

-- ───────────────────────── tenant-scoped ───────────────────────
create table profile (
  id                uuid primary key default uuid_generate_v4(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  master_resume     text not null default '',
  profile_embedding vector(1536),
  yoe               numeric not null default 0,
  level_band        text not null default 'mid',
  prefs             jsonb not null default '{}',
  unique (tenant_id)
);

create table evidence (
  id         uuid primary key default uuid_generate_v4(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  project    text not null,
  headline   text not null,
  detail     text not null,
  metric     text,
  tags       text[] not null default '{}',
  embedding  vector(1536)
);
create index evidence_tenant_idx on evidence (tenant_id);

create table match (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  posting_id      uuid not null references posting(id) on delete cascade,
  score           numeric not null,
  score_breakdown jsonb not null default '{}',
  rule_pass       boolean not null default true,
  why_fit         text,
  gap             text,
  stack_note      text,
  level_note      text,
  red_flags       text[] not null default '{}',
  generated_at    timestamptz not null default now(),
  unique (tenant_id, posting_id)
);
create index match_rank_idx on match (tenant_id, rule_pass, score desc);

create table application (
  id                  uuid primary key default uuid_generate_v4(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  posting_id          uuid not null references posting(id) on delete cascade,
  status              text not null default 'saved',
  applied_via         text,
  tailored_resume_url text,
  resume_variant      text,
  answers             jsonb not null default '{}',
  submitted_at        timestamptz,
  next_action         text,
  next_action_at      timestamptz,
  outcome             text,
  unique (tenant_id, posting_id)
);
create index application_next_action_idx on application (tenant_id, next_action_at);

create table prep_doc (
  id           uuid primary key default uuid_generate_v4(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  posting_id   uuid not null references posting(id) on delete cascade,
  dossier      text,
  question_set jsonb not null default '[]',
  study_plan   text,
  evidence_map jsonb not null default '{}'
);

create table question_bank (
  id                    uuid primary key default uuid_generate_v4(),
  tenant_id             uuid not null references tenant(id) on delete cascade,
  company_id            uuid references company(id) on delete set null,
  role_type             text not null,
  question              text not null,
  ideal_approach        text,
  source_application_id uuid references application(id) on delete set null
);

create table salary_cache (
  key             text primary key,
  role_archetype  text,
  location        text,
  est_min         numeric,
  est_max         numeric,
  currency        text,
  source          text,
  confidence      text,
  fetched_at      timestamptz not null default now(),
  ttl             interval not null default '14 days'
);

create table trend_snapshot (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid references tenant(id) on delete cascade,
  period        text not null,
  skill         text not null,
  freq          int not null,
  freq_delta    int not null default 0,
  in_target_set boolean not null default false
);
