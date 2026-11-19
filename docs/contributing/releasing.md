# Releasing

JobFlow is released from `main` as a tagged GitHub release. Nothing is published to npm:
users run it from a clone (`pnpm jobflow`, `jobflow serve`, Docker Compose). Releases are cut
by maintainers. Contributors only need the [CHANGELOG](#the-changelog) part.

## Versioning

JobFlow follows [Semantic Versioning](https://semver.org/). Before 1.0, a minor bump
(0.1 → 0.2) may include breaking changes, and the CHANGELOG calls them out. Count as
breaking:

- a removed or renamed CLI command, option, `--json` field or exit code;
- an environment variable that changes meaning or goes away;
- a migration that needs manual steps, or data that older versions can't read;
- a change to an API route the browser extension or API-token scripts call.

All workspace packages share one version. A release bumps every one of these together:

- `version` in the root `package.json` and in each `packages/*/package.json` and
  `apps/*/package.json`;
- `VERSION` in `apps/cli/src/program.ts` (what `jobflow --version` prints) and in
  `apps/agent/src/index.ts`;
- `version` in `apps/extension/manifest.json`, if the extension changed. The extension is
  loaded unpacked and carries its own version.

```bash
grep -rn '"version"' package.json packages/*/package.json apps/*/package.json apps/extension/manifest.json
grep -rn 'VERSION = "' apps/cli/src apps/agent/src
```

## The CHANGELOG

[CHANGELOG.md](../../CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every pull request with a user-visible change adds a line under `## [Unreleased]` at the top
(add the heading if it isn't there), in the Keep a Changelog section that fits: **Added**,
**Changed**, **Fixed**, **Removed**, **Security** or **Docs**. Anything breaking goes under
**Changed** or **Removed** and says so. (The release notes, not the CHANGELOG, regroup the
highlights by theme: finding jobs, honest recommendations, your profile, applying.)

Write for users: what they can now do, or what behaves differently, in one line. "Search
results now say how many jobs each filter hid", not "refactor applyView".

## Cutting a release

1. **Check `main` is green.** CI passes (build, typecheck, tests, PII and tenant guards).
   Locally:

   ```bash
   pnpm install --frozen-lockfile && pnpm -r build && pnpm -r typecheck && pnpm -r test
   node scripts/check-pii.mjs && node scripts/check-tenant.mjs
   pnpm demo                   # live smoke test
   ```

2. **Walk the first-run journeys.** On a fresh data directory, run `jobflow init` → `sync` →
   `feed` → `show 1` → `tailor 1` → `apply 1` (dry run), and in the web app the onboarding,
   Jobs, a Job page and Sources. [UX_AUDIT.md](../internal/UX_AUDIT.md) §2 lists the
   journeys.
3. **Refresh screenshots** if the UI changed: `pnpm screenshots`
   ([web-ui.md](web-ui.md#screenshots-and-visual-review)).
4. **Bump the version** everywhere listed above, and rename `## [Unreleased]` in the
   CHANGELOG to `## [x.y.z] — YYYY-MM-DD`.
5. **Write the release notes** as `docs/internal/RELEASE_NOTES_vX.Y.Z.md`: a short summary,
   how to get started or upgrade, highlights, and breaking changes.
   [RELEASE_NOTES_v0.1.0.md](../internal/RELEASE_NOTES_v0.1.0.md) is the model.
6. **Commit, tag and publish** from the default branch:

   ```bash
   git commit -s -am "Release vX.Y.Z"
   git tag -a vX.Y.Z -m "JobFlow vX.Y.Z"
   git push origin main vX.Y.Z
   gh release create vX.Y.Z --title "JobFlow vX.Y.Z" --notes-file docs/internal/RELEASE_NOTES_vX.Y.Z.md
   ```

7. **Start the next cycle** with an empty `## [Unreleased]` section in the CHANGELOG.

The owner-only steps for the first public release (history scrub, repository settings,
branch protection, Discussions, private vulnerability reporting) are in
[PUBLISHING.md](../internal/PUBLISHING.md). Run its "Before flipping the switch" checklist
before any release that changes who can see the repository.

## Upgrades and migrations

Migrations apply automatically when PGlite opens, so CLI and local web users upgrade with
`git pull && pnpm install && pnpm -r build`. Postgres deployments run `pnpm db:migrate` (or
`pnpm docker:migrate`). If a release needs anything more, say so in the release notes and the
CHANGELOG.
