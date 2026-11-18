-- Store-level metadata (§11.3): small key → value rows about the corpus itself, e.g. the
-- `normalize_version` the stored postings were derived with. `pollAll` compares it with the
-- code's NORMALIZE_VERSION and re-derives stored postings once when the code is newer, so a
-- local install picks up a parser fix on its next sync without running the worker.
-- Shared-global like posting (no tenant): read for everyone, written by the service role.
-- Idempotent: safe to re-run.

create table if not exists store_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table store_meta enable row level security;
drop policy if exists store_meta_read on store_meta;
create policy store_meta_read on store_meta for select using (true);
