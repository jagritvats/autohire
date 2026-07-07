-- Row-level security (§6.1). Isolation enforced at the database, so app code can't
-- leak across tenants even if it slips. Shared-global tables (company, posting,
-- stack_edge, salary_cache) are readable by all; the service role (the pollers +
-- worker connect this way) bypasses RLS and writes everything.
--
-- The tenant helper lives in `public` (not `auth`) so the restricted Supabase-local
-- `postgres` role can create it. It reads a custom `tenant_id` JWT claim; defaults
-- to the single-tenant id when there's no JWT (direct service connections).

create or replace function public.current_tenant() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', ''),
    '00000000-0000-0000-0000-000000000001'
  )::uuid
$$;

-- tenant-scoped tables
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_config','profile','evidence','match','application',
    'prep_doc','question_bank'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format($f$
      create policy %1$s_tenant_isolation on %1$s
        using (tenant_id = public.current_tenant())
        with check (tenant_id = public.current_tenant());
    $f$, t);
  end loop;
end $$;

-- trend_snapshot: tenant rows isolated, global rows (tenant_id null) readable by all
alter table trend_snapshot enable row level security;
create policy trend_read on trend_snapshot for select
  using (tenant_id is null or tenant_id = public.current_tenant());
create policy trend_write on trend_snapshot for all
  using (tenant_id = public.current_tenant()) with check (tenant_id = public.current_tenant());

-- shared-global: read for everyone, write reserved to the service role (bypasses RLS)
alter table company enable row level security;
alter table posting enable row level security;
alter table stack_edge enable row level security;
alter table salary_cache enable row level security;

create policy company_read on company for select using (true);
create policy posting_read on posting for select using (true);
create policy stack_read on stack_edge for select using (true);
create policy salary_read on salary_cache for select using (true);
