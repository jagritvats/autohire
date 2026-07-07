-- Phase 3 enrichment. Company-level comp benchmark (from levels.fyi, attributed)
-- and ratings (from Tier-3 local agent, Phase 4) surface on the card + company view.
-- Posting-level salary estimates reuse the existing posting.salary_* columns; the
-- salary_cache table (0001) memoizes role+location lookups with a TTL.

alter table company
  add column if not exists comp_median     numeric,
  add column if not exists comp_currency    text,
  add column if not exists comp_source       text,
  add column if not exists comp_breakdown    jsonb,     -- [{family, median}] from levels.fyi
  add column if not exists comp_updated_at   timestamptz,
  add column if not exists enriched_at        timestamptz;

create index if not exists company_enriched_idx on company (enriched_at);
