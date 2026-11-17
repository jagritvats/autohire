# JobFlow — product plan (open-source, multi-user)

Synthesized from six parallel planning passes (multi-tenancy/auth, résumé inputs +
onboarding, saved searches + configurable discovery, CLI, external-flows audit,
OSS readiness + privacy). This is the plan the productization work follows; each
section names the decision taken where the passes disagreed.

## Goals

1. **Per-user capability** — every user has their own profile, evidence, config, LLM key,
   saved searches, discovery sources, applications, matches and API tokens. Postings and
   the company registry stay a shared, global corpus.
2. **Fix external flows** — everything that crosses a process/network boundary works for a
   stranger who clones the repo (LLM providers, `.env`, Docker, extension, agent, autofill,
   CI, first feed load, demo).
3. **Résumé inputs** — PDF, DOCX, LaTeX, Markdown, text, JSON Resume, LinkedIn export, paste →
   reviewed profile + Evidence Bank drafts, deterministic first, LLM-assisted optional and
   grounded.
4. **Specific job searches** — saved searches that (a) drive search-capable sources and
   (b) act as explicit feed views (counts of what is hidden; ranking stays soft, invariant #4);
   plus one-off ad-hoc search.
5. **Configurable discovery, in addition to the current one** — today's discovery becomes the
   `india` preset (unchanged behaviour); add `global-remote`, `us`, `eu-uk` presets and
   per-user custom sources (company boards, CSV company lists, RSS/Atom, JSON feeds,
   Telegram channels, HN threads).
6. **CLI access** — an installable `jobflow` binary with persistent zero-infra storage.
7. **Open-source** — no personal data, licence, contributing guide, guides, screenshots, CI.

## Key decisions

| Topic | Decision | Why |
|---|---|---|
| Auth | `JOBFLOW_AUTH=none` (default, loopback-only + same-origin) or `password` (scrypt + signed httpOnly session cookie). API tokens `jft_<id>.<secret>` (sha256 at rest, scoped `cli`/`extension`/`agent`, revocable). Supabase Auth: seam only. | Works on in-memory, plain Postgres and PGlite; no vendor lock. |
| Job tenancy | Keep `job.tenant_id NOT NULL`; global jobs (discover/poll/recheck/purge/liveness) run under the system tenant (`DEFAULT_TENANT`); worker fans out `rank` per active tenant. | Avoids a nullable ripple through UI/agent. |
| Local agent | Direct-DB agent, tenant resolved from `JOBFLOW_AGENT_TOKEN` (or `DEFAULT_TENANT` in `none` mode). HTTP agent port for hosted multi-user is roadmap. | Self-host first; a hosted agent must not hold DB creds. |
| Shared logic | New `@jobflow/service` package (feed, tailor, tenant bootstrap, sync, apply plan) used by web, CLI, worker. | `pipeline` must not depend on `llm`; web `lib/*` logic was unreachable from the CLI. |
| CLI storage | PGlite (Postgres-in-WASM) under `~/.jobflow` reusing the same SQL + migrations; `DATABASE_URL` wins; in-memory via `--store memory`. | One SQL dialect; no third repository impl. |
| CLI parser | `commander`. | Nested subcommands + help + testable in-process. |
| Résumé parsing | Pure parser in `core/src/resume`; bytes→text in new `@jobflow/resume-io` (pdf-parse + fflate DOCX/ZIP); optional LLM extraction in `llm/src/extract.ts`, filtered through `groundDraft` (nothing kept that isn't in the source). | Keeps binary deps out of core/worker; invariant #3. |
| First run | Blank profile + onboarding wizard (web) / `jobflow init` (CLI). Fictional "Alex Example" sample only for demo/tests/screenshots. | Strangers must never start as the author. |
| Region | `prefs.homeCountry` + `prefs.markets` replace hard-coded India in scoring, polling country and Tier-3 hubs. Existing installs default to the `india` preset. | Same behaviour for the existing user; correct for everyone else. |
| Views vs ranking | `applyView()` hides only on confidently-known values, never changes `Match.score`, always reports hidden counts. | Invariant #4. |
| Custom feeds | Generic RSS/JSON adapters are Tier 1 with `safeUrl()` SSRF guard, trust 0.45, in `REDATED_SOURCES`. | User-supplied URLs are fetched by the server. |
| Licence | MIT (owner may switch to AGPL-3.0 before first public release). | Maximises adoption; reversible while the owner holds all copyright. |

## Migrations

- `0014_auth.sql` — `app_user`, `auth_session`, `api_token`, `tenant.last_active_at`, RLS.
- `0015_tenant_scope.sql` — `agent_heartbeat.token_id`, `tenant_config.llm_api_key_enc`, `posting.contributed_by`, job index.
- `0016_profile_onboarding.sql` — `profile.onboarded_at`, `profile.resume_file`, `evidence.origin`; backfill `onboarded_at` where a résumé exists.
- `0017_discovery_searches.sql` — `saved_search`, `discovery_source`, `company_follow`, `tenant_config.discovery_preset/preset_feeds_disabled`, `company.poll_markets`.

## Phases

0. **Foundation (sequential)** — privacy scrub (résumé PDF, hard-coded contact, author seed →
   fictional sample + blank profile), shared Zod schemas, Repository interface + in-memory impl.
1. **Parallel** — (A) db: migrations, Pg impls, PGlite + SqlClient, auth crypto, `.env` parser,
   stuck-job requeue; (B) résumé parser + `resume-io` + LLM extract; (C) discovery: presets,
   RSS/JSON adapters, search targets, discovery plan, ad-hoc search, views, home country,
   Workday fallback; (D) external fixes: LLM providers, autofill, extension, Docker/env, CI.
2. **Service + auth** — extract `@jobflow/service`; thread tenant through web; auth routes,
   CSRF/origin middleware, config key masking, tokens; worker per-tenant fan-out; agent token.
3. **Parallel** — (E) web UI: login/signup, onboarding wizard, searches, discovery settings,
   tokens panel, feed views; (F) CLI.
4. **OSS** — docs IA + guides, CONTRIBUTING/CoC/SECURITY/templates, PII guard in CI,
   fixture-mode screenshots, README rewrite.

## Owner-only steps (destructive, not done by automation)

The author's résumé PDF and contact details exist in git history. Before making the repo
public either publish a fresh squashed history (recommended) or rewrite with
`git filter-repo` — see `docs/internal/PUBLISHING.md`.
