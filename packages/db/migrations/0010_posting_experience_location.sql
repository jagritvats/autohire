-- Parsed years-of-experience + location-confidence on the shared posting (§11.2, §11.3).
-- Both are deterministic parse outputs (no per-job LLM): experience_min/max is the YoE
-- band the JD asks for; location_confidence is how much we trust the parsed geo, so the
-- matcher can be honest ("verify before applying") instead of scoring a guess as fact.
-- Idempotent: safe to re-run.

alter table posting
  add column if not exists experience_min      numeric,
  add column if not exists experience_max      numeric,
  add column if not exists location_confidence numeric not null default 0.5;
