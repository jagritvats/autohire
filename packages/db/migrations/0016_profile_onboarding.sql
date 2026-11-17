-- Onboarding + résumé files + evidence provenance (docs/internal/PRODUCT_PLAN.md).
--  * profile.onboarded_at — set when the user finishes onboarding (web wizard / `jobflow
--    init`); null sends them to it.
--  * profile.resume_file — StoredFile jsonb ({key, filename, mime, sha256, bytes,
--    uploadedAt}) of the uploaded base résumé; the bytes live in the file store.
--  * evidence.origin — where an Evidence Bank entry came from (manual | resume | linkedin |
--    json_resume | sample); `sample` marks the fictional demo persona.
-- Idempotent: safe to re-run.

alter table profile
  add column if not exists onboarded_at timestamptz,
  add column if not exists resume_file  jsonb;

alter table evidence
  add column if not exists origin text not null default 'manual';

-- existing users who already have a résumé are onboarded — don't bounce them to the wizard
update profile set onboarded_at = now()
 where onboarded_at is null and (master_resume <> '' or resume_latex <> '');
