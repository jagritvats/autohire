-- Two posting columns (§3, §11):
--  * posted_by_agency — the source's own "posted by a consultancy" flag (Naukri marks
--    these); the trust score's prose regexes catch the rest.
--  * embed_key — "{embedder id}:{hash of the embedded text}" for jd_embedding. A re-poll
--    whose key is unchanged reuses the stored vector instead of paying to re-embed it;
--    a different embedding model changes the key, so vectors never mix models.
-- Idempotent: safe to re-run.

alter table posting
  add column if not exists posted_by_agency boolean not null default false,
  add column if not exists embed_key text;
