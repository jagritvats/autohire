# Working on the web UI

The web app (`apps/web`) is a Next.js 14 app router project. It is the same product as the
CLI: both call `@jobflow/service` for everything that isn't presentation. This guide covers
how pages are built, the design system they share, the UX rules every screen follows, and
how to review a visual change.

The full design spec is [docs/internal/DESIGN.md](../internal/DESIGN.md) (tokens, measured
contrast, component anatomy). The journeys and information architecture are in
[docs/internal/UX_AUDIT.md](../internal/UX_AUDIT.md). Read both before a large UI change.

## Run it

```bash
pnpm web                                              # dev server on http://localhost:3000, your local data
JOBFLOW_DEMO_DATA=1 JOBFLOW_STORE=memory pnpm web     # an offline, fictional corpus (UI work, screenshots)
pnpm jobflow serve                                    # the web UI on the same data as the CLI
```

With nothing configured, the web app opens the same durable PGlite store as the CLI
(`~/.jobflow`, or `JOBFLOW_DATA_DIR`). That store takes one writer at a time, so a running
web server blocks `jobflow` commands that write, and the reverse. For UI work, demo mode is
the easiest: nothing is saved and no live API is called. To keep your own job search apart
from development, point `JOBFLOW_DATA_DIR` at a scratch directory.

## How a page is put together

```
app/layout.tsx              <AppShell> around every page: skip link, header, THE nav, <main id="main">
app/<route>/page.tsx        server component: pageAuth() → <AppFrame title intro actions> → a view
components/<Name>View.tsx   client component: state, fetches /api/*, renders ui/ primitives
app/api/<route>/route.ts    guard(req) → @jobflow/service call with auth.tenantId → JSON
lib/*.ts                    web-only glue (repo, auth, nav, card text). App logic goes in packages/service.
```

- **Navigation is data.** `apps/web/lib/nav.ts` exports `NAV` (Jobs, Search, Applications,
  Profile, Sources, Settings) and `activeNav()`. `apps/web/components/ui/AppShell.tsx`
  renders it on every page with `aria-current="page"`. A secondary route lights its parent
  through `match` (a job page lights Jobs). Don't add per-page navs. If you add a top-level
  section, change `NAV` and the test in `apps/web/test/journeys.test.ts`.
- **One page frame.** `apps/web/components/AppFrame.tsx` gives the page container and its
  only `h1` (through `PageHeader`). Pass `wide` for data-dense pages. Panels inside use
  `h2`.
- **Auth.** Server pages call `pageAuth()`. API routes call `guard(req)` (or wrap the handler
  in `withAuth`) and pass `auth.tenantId` to every service call. Never import
  `DEFAULT_TENANT` in web code: `scripts/check-tenant.mjs` fails CI if a route skips
  `guard`/`withAuth`/`requireAuth` or uses the constant. See
  [data-and-migrations.md](data-and-migrations.md#tenant-isolation).
- **Never poll inside a request.** An empty corpus starts one deduped background sync
  (`startCorpusSync`). The page shows progress and swaps the jobs in when they arrive.
- **Plain-language card text** lives in `apps/web/lib/cardText.ts` (location, pay,
  experience), and is tested in `apps/web/test/journeys.test.ts`. A modeled salary must
  never read as a stated one.

## The design system

Tokens and component classes are in `apps/web/app/globals.css`. React wrappers are in
`apps/web/components/ui/` and exported from `apps/web/components/ui/index.ts`. Compose these.
Don't add one-off colours, font sizes, spacing or shadows.

### Tokens and themes

- The look is Concept A, "Editorial light" ([DESIGN.md](../internal/DESIGN.md#concept-a--editorial-light)).
  Light (warm paper) is the `:root` base. Dark ("night paper") applies when the OS asks for
  it, or when the user picks it with the header toggle (`ThemeToggle`, stored in
  `localStorage["jobflow-theme"]`). Every colour token is defined for both themes, so use
  `var(--text-2)`, never a hex value.
- Two faces: `--font-display` (Fraunces) for headings and score numerals, and `--font-sans`
  (Schibsted Grotesk) for everything else. `h1`–`h3` get the display face automatically.
- Type sizes (`--fs-2xs` 11px to `--fs-2xl` 44px, plus `--fs-score`), spacing on a 4px grid
  (`--s-1` to `--s-16`), radii, control heights and shadows are all tokens. Nothing is smaller
  than 11px. Numbers use tabular figures.
- Sections are separated by rules (`--border`, `--border-strong`, the ink `--rule`), not
  boxes. Don't wrap new content in a bordered card.
- Monospace (`--font-mono`) is for code-like content only: the search syntax, LaTeX,
  ATS slugs.

### Colour carries meaning

One accent (vermilion) means "you can act here". Four semantic tones mean the same thing on
every page:

| Tone | Means | Examples |
|---|---|---|
| `good` | strong match, verified, done | high score, fresh posting, durable store |
| `info` | a neutral fact worth noticing | ATS-direct, a fair score, sync in progress |
| `warn` | read this before you apply | red flags, US-only "remote", low trust, Tier 3 |
| `bad` | exclusion, invalid, destructive | errors, delete, invalidated |

Use the `tone` prop (`Badge`, `Banner`, `Panel`) instead of picking a colour. An estimate is
always marked as an estimate: a modeled salary gets `.badge--estimate` (dashed border, `~`,
`est N%`).

### Contrast

Text pairs must be at least 4.5:1 in **both** themes, and UI edges (input borders, focus
ring) at least 3:1. The measured pairs are in
[DESIGN.md](../internal/DESIGN.md#measured-contrast-wcag-22-aa-text--45-ui--3). If you
change a palette value, recompute the table and update it in the same PR.

### Primitives

| Need | Use |
|---|---|
| A button or button-styled link | `Button`, `ButtonLink`, `btn()`. One `primary` per view region. |
| A toggle (filter, choice) | `Chip` (`aria-pressed`) |
| A static fact | `Badge` with a tone |
| A notice, or an async result | `Banner` (`live` makes it a polite live region; `bad` becomes an alert) |
| A titled section | `Panel` (renders an `h2`) |
| A form control | `Field` (every control has a visible label or an `aria-label`) |
| Nothing here yet | `EmptyState` (title, what this place is for, the action that fills it) |
| Loading | `Skeleton` plus a live "Loading…" message |
| A view switch | `Segmented` |
| A number | `Stat` |
| Icons | `Icon` (decorative icons are `aria-hidden`) |
| A long form's section index | `SectionNav` |
| A filter rail that becomes a sheet on mobile | `FilterDrawer` |

Older markup still uses legacy class names (`.card-block`, `.save`, `.cmd`, `.tag`) that are
aliased onto the primitives in `globals.css`. New code uses the canonical names. Converting a
component is a welcome small PR.

## UX rules

These come from [UX_AUDIT.md](../internal/UX_AUDIT.md) and hold on every screen.

- **Views report what they hide.** A filter or saved-search view hides only on values that
  are confidently known, never changes a score, and always says what it hid ("7 hidden by
  your filters: 4 work mode, 3 min score · clear filters"). A view that hides things
  silently is a bug.
- **Always show the next step.** Every success state says what changed and what to do next.
  From a job, Save, Tailor, Apply and Track are always in view.
- **Four states for every list:** loading (a skeleton, never "No results"), empty (what this
  place is for, plus the action that fills it), error (what failed, why if known, what to do),
  and success.
- **Say the never-submit guarantee as a promise.** "You always press submit", not a warning.
  There is no submit button for an employer's form anywhere in JobFlow.
- **No invented scores.** Before onboarding, results are unscored and the page says so.
  Profile-relative notes ("not in your stack") appear only when there is a profile.
- **Plain language.** No internal terms in copy ("archetype", "tier-1", section numbers).
  Name things as the nav does.
- **Region-neutral.** Never hard-code a country, currency or market. Use the profile's home
  country and markets.

## Accessibility checklist

- [ ] One `h1` per page (from `AppFrame`); headings in order. The page's content is inside the
      shell's `<main id="main">`, which the skip link targets.
- [ ] Every control is reachable and usable by keyboard, with the visible 2px focus ring.
- [ ] No click handlers on non-interactive elements. Toggles expose `aria-pressed`; menus
      expose `aria-expanded` and `aria-controls`.
- [ ] Async results, saves and sync progress are announced (`Banner live` or `aria-live`).
- [ ] Animations stop under `prefers-reduced-motion`; nothing depends on motion.
- [ ] At 375px wide nothing scrolls horizontally, and touch targets grow on coarse pointers.
- [ ] Contrast holds in light and dark.

## Screenshots and visual review

Screenshots come from the **built** app in demo mode, so they are reproducible and show only
fictional people and companies:

```bash
pnpm screenshots                                                   # build the web app, then shoot everything
pnpm --filter @jobflow/web build && node scripts/screenshots.mjs --only jobs,settings-light
```

`scripts/screenshots.mjs` starts the app with `JOBFLOW_DEMO_DATA=1` and the echo model, then
writes `docs/screenshots/*.png`: every page in dark, key pages in light (`*-light.png`), and
375px mobile views (`*-mobile*.png`). It warns when a page overflows horizontally. It needs
Playwright and Chromium. If Playwright isn't resolvable from the repo root the script prints
how to add it; don't commit that `package.json` change. If Playwright can't find its own
Chromium, set `JOBFLOW_CHROMIUM` to a local Chrome or Chromium. The `cli-*.png` images are
terminal captures and are not produced by this script.

For a PR that changes the UI:

- Attach before/after screenshots of what changed, in **light and dark**, and at **mobile**
  width when layout is involved. `--only <name>` limits a run to the pages you touched.
- Update `docs/screenshots/` only when a screenshot used by the README or guides is now
  wrong, and regenerate it with the script rather than by hand.
- Never take a screenshot from your own data. Use demo mode.
