-- Accounts, sessions and API tokens (per-user capability; docs/internal/PRODUCT_PLAN.md).
-- Plain-Postgres auth (no Supabase Auth dependency) so it works on Postgres, Supabase and
-- PGlite alike. Secrets are never stored: passwords as scrypt hashes, session/token
-- secrets as sha256. `external_id` is the seam for an external IdP (e.g. Supabase Auth).
-- Idempotent: safe to re-run.

create table if not exists app_user (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  email          text not null,
  password_hash  text,                    -- null = external-IdP / token-only user
  role           text not null default 'member',   -- admin | member
  external_id    text unique,
  created_at     timestamptz not null default now(),
  disabled_at    timestamptz
);
-- emails are unique case-insensitively (lookups use lower(email))
create unique index if not exists app_user_email_idx on app_user (lower(email));
create index if not exists app_user_tenant_idx on app_user (tenant_id);

create table if not exists auth_session (
  id            text primary key,          -- public half of the cookie
  user_id       uuid not null references app_user(id) on delete cascade,
  tenant_id     uuid not null references tenant(id) on delete cascade,
  secret_hash   text not null,             -- sha256 of the cookie's secret half
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  user_agent    text
);
create index if not exists auth_session_user_idx on auth_session (user_id);
create index if not exists auth_session_tenant_idx on auth_session (tenant_id);
create index if not exists auth_session_expires_idx on auth_session (expires_at);

create table if not exists api_token (
  id            text primary key,          -- `jft_<id>.<secret>`
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid references app_user(id) on delete cascade,
  name          text not null default '',
  scopes        text[] not null default '{}',     -- extension | agent | cli
  secret_hash   text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);
create index if not exists api_token_tenant_idx on api_token (tenant_id, created_at);

-- worker rank fan-out only visits tenants active recently (null = never marked → counted)
alter table tenant add column if not exists last_active_at timestamptz;

-- RLS (same pattern as 0002/0003/0007). The service role (web server, worker, agent)
-- bypasses; a tenant JWT sees only its own rows.
do $$
declare t text;
begin
  foreach t in array array['app_user','auth_session','api_token']
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
