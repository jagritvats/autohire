-- Salary estimation (§11.4). Idempotent: safe to re-run.
--
--  * posting.salary_estimate — the MODELED band for a posting that states no pay (jsonb
--    SalaryEstimate: p25/median/p75, confidence_score 0..1, sources, basis). Separate from
--    salary_* (what the posting states) so the upsert on every re-poll never wipes it and
--    nothing can read a guess as a stated salary.
--  * posting.salary_raw — the source's own salary text, so an extractor fix re-parses stored
--    postings exactly instead of waiting for each board's next poll.
--  * company.comp_benchmarks — per-role pay from comp sites, one entry per source
--    (AmbitionBox CTC by designation). jsonb CompanyCompBenchmark[].
--  * salary_cache gains the median + sample size market benchmarks carry (levels.fyi
--    market×level, Adzuna role×level×country).

alter table posting
  add column if not exists salary_estimate jsonb,
  add column if not exists salary_raw text;

alter table company
  add column if not exists comp_benchmarks jsonb not null default '[]';

alter table salary_cache
  add column if not exists est_median numeric,
  add column if not exists sample_count int;
