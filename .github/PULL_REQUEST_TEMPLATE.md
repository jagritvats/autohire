## Summary

<!-- What changes for users, and why? Link issues with "Fixes #123". -->

## How I tested it

<!-- Commands you ran, journeys you walked, what you saw. -->

## Invariants checklist

See [CLAUDE.md](../CLAUDE.md#invariants-do-not-break-these). Tick each one, or say why it doesn't apply.

- [ ] **Tier boundary**: no Tier-3 adapter is reachable from the worker, web server or cron (nothing new in `ADAPTERS`/`cloudAdapters()` from `tier3/`); no server path holds a user's site session.
- [ ] **Never submits**: no autofill code path, CLI command/option or UI action submits an application; `JOBFLOW_AUTOSUBMIT` stays hard-false.
- [ ] **Grounded generation**: new generation passes `HONEST_VOICE`, the candidate block and evidence; `PROMPT_VERSION` bumped if a prompt or generator changed.
- [ ] **Soft ranking**: no new hard filter; new signals are weighted components with honest flags; views report what they hide.
- [ ] **Idempotent upserts + freshness**: postings key on `(atsType, atsJobId)` / `scopedJobId`; nothing is staled from a partial or failed fetch.
- [ ] **One type system**: shared shapes come from `@jobflow/core`.
- [ ] **Tenant isolation**: every tenant-scoped read/write passes the caller's tenant id; API routes use `guard()`/`withAuth()`; `node scripts/check-tenant.mjs` passes.
- [ ] **Privacy**: no real personal data (names, emails, phone numbers, résumés, tokens, cookies) in code, fixtures, screenshots or logs; fixtures use fictional people at `example.com`; new users still start from `blankProfile()`; `node scripts/check-pii.mjs` passes.
- [ ] **User URLs** (if any): fetched only through `safeUrl`/`safeFetchText`.

## Checks

- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test` pass locally
- [ ] Added or updated tests for the change (offline: no live HTTP)
- [ ] Ran `pnpm demo` (if `core`, `adapters` or `pipeline` changed)
- [ ] Database change: numbered idempotent migration, RLS on tenant tables, both stores, `packages/db/test/contract.test.ts` extended
- [ ] CHANGELOG entry under `## [Unreleased]` for user-visible changes

## UI changes (delete if none)

- [ ] Screenshots of what changed in **light and dark**, plus **mobile (375px)** if layout changed (demo mode only: `JOBFLOW_DEMO_DATA=1`)
- [ ] Uses tokens and `components/ui/` primitives; one `h1`; keyboard and screen-reader checked
- [ ] Loading, empty and error states say what to do next

## CLI changes (delete if none)

- [ ] `--help` text is clear and [docs/cli.md](../docs/cli.md) is updated
- [ ] `--json` output works (one document on stdout; hints on stderr); exit codes follow the contract
- [ ] In-process tests in `apps/cli/test/`

## Licence

- [ ] Every commit is signed off (`git commit -s`, the [DCO](https://developercertificate.org/)), and I agree to license this contribution under AGPL-3.0-only.
