-- Stated salary units (§11.4). salary_min / salary_max stay ANNUAL (every comparison reads
-- them); these record how the posting STATED its pay, for display and honest flags:
--  * salary_period — year | month | week | day | hour. NULL on older rows = "year" (what
--    they were annualised to). An hourly/daily/weekly figure is shown "annualised from
--    hourly" and never drives the hard salary floor.
--  * salary_basis  — base | ote | total (NULL = not said).
--  * salary_equity — the posting mentions equity / stock on top (never counted as pay).
-- FX rates are cached in store_meta ('fx_rates', JSON with its own date) — no table needed.
-- Idempotent: safe to re-run.

alter table posting
  add column if not exists salary_period text,
  add column if not exists salary_basis text,
  add column if not exists salary_equity boolean;
