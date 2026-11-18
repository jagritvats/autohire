-- Two posting columns for location (§11.3):
--  * loc_countries — every country (ISO-2, primary first) the location string places the
--    role in. A Greenhouse role with offices in Austin and London is {US,GB}; market
--    matching and the "abroad" checks consider any of them. NULL on older rows: readers
--    fall back to loc_country.
--  * location_raw — the source's own location text, so a parser fix can re-derive the
--    location of stored postings (the worker's `renormalize`) without a re-poll.
-- Idempotent: safe to re-run.

alter table posting
  add column if not exists loc_countries text[],
  add column if not exists location_raw text;
