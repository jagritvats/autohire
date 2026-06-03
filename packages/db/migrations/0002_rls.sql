-- Row-level security (§6.1). Isolation enforced at the database, so app code can't
-- leak across tenants even if it slips. Shared-global tables (company, posting,
-- stack_edge, salary_cache) are readable by all authenticated users and written
-- only by the service role (the pollers run as service role).

-- helper: current tenant id from the JWT claim set by the app on login
create or replace function auth.tenant() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', ''),
    '00000000-0000-0000-0000-000000000000'
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
        using (tenant_id = auth.tenant())
        with check (tenant_id = auth.tenant());
    $f$, t);
  end loop;
end $$;

-- trend_snapshot: tenant rows isolated, global rows (tenant_id null) readable by all
alter table trend_snapshot enable row level security;
create policy trend_read on trend_snapshot for select
  using (tenant_id is null or tenant_id = auth.tenant());
create policy trend_write on trend_snapshot for all
  using (tenant_id = auth.tenant()) with check (tenant_id = auth.tenant());

-- shared-global: read for all authenticated, write reserved to service role
alter table company enable row level security;
alter table posting enable row level security;
alter table stack_edge enable row level security;
alter table salary_cache enable row level security;

create policy company_read   on company    for select using (true);
create policy posting_read   on posting    for select using (true);
create policy stack_read     on stack_edge for select using (true);
create policy salary_read    on salary_cache for select using (true);
-- (service_role bypasses RLS automatically, so pollers can write these.)
