## Summary

<!-- What does this change and why? Link issues with "Fixes #123". -->

## Invariants checklist

- [ ] **Tier boundary** — no Tier-3 adapter is reachable from the cloud (worker, web server, cron); no server path holds a user's site session.
- [ ] **Never submits** — no autofill code path clicks submit; `JOBFLOW_AUTOSUBMIT` stays hard-false.
- [ ] **Grounded generation** — new generation passes `HONEST_VOICE`, the candidate block and evidence; `PROMPT_VERSION` bumped if a prompt changed.
- [ ] **Soft ranking** — no new hard filter; new signals are weighted components with honest flags.
- [ ] **Idempotent upserts** — postings key on `(atsType, atsJobId)` / scoped ids; no staling on partial fetches.
- [ ] **One type system** — shared shapes come from `@jobflow/core`.
- [ ] **Tenant isolation** — every tenant-scoped read/write passes the caller's tenant id.

## Tests

- [ ] `pnpm -r build && pnpm -r test` pass locally
- [ ] Added/updated tests for the change

## Licence

- [ ] My commits are signed off (`git commit -s`) and I agree to license this contribution under AGPL-3.0-only.

## Privacy

- [ ] No real personal data (names, emails, résumés, tokens) in code, fixtures, screenshots or logs — fixtures use fictional people at `example.com`.
