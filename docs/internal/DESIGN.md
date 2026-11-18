# JobFlow web — design system ("calm ledger")

The visual contract for `apps/web`. Tokens and component classes live in
`apps/web/app/globals.css`; React wrappers in `apps/web/components/ui/`. If you add UI, compose
these. Don't add bespoke colours or sizes.

## Rationale

JobFlow is a tool someone opens every day during a stressful search. They scan dozens of
postings, then act on a few. So the interface should be:

- **Calm and trustworthy, not "hacker".** The v0.1 look (phosphor-green on near-black, film
  grain, serif headlines, 9–10px uppercase mono labels) read as a demo. Small low-contrast mono
  text also failed AA (old `--ink-faint` was 3.2:1). It's replaced with neutral surfaces, one
  sans typeface, and real hierarchy. References: Linear and Vercel/Geist for density and
  restraint, GitHub Primer for semantic colour roles, Radix Colors for accessible 12-step scales,
  and Otta/Teal for job-card anatomy (role first, then company, then facts as chips).
- **Colour carries meaning only.** One accent (indigo) means "you can act here". Four semantic
  tones mean the honesty signals, and they mean the same thing on every page:

  | tone | meaning | examples |
  |---|---|---|
  | `good` (green) | strong match / verified / done | score ≥ 78, fresh ≤ 3d, in CRM, durable store, agent online |
  | `info` (blue) | neutral fact worth noticing | ATS-direct, fair score 60–77, sync in progress |
  | `warn` (amber) | caution: read before you apply | red flags, us/eu-only "remote", low trust, tier-3, YoE stretch, stale poll |
  | `bad` (red) | exclusion / invalid / destructive | YoE far, invalidated, errors, delete |

  The score band no longer uses amber for "mid" (in v0.1 it collided with caution flags). Mid is
  blue and low is grey.
- **Never hide that an estimate is an estimate.** A modeled salary gets a dashed border
  (`.badge--estimate`), a leading `~`, and `est N%`. A stated salary has a solid border and its
  parse confidence. Flags are full-width amber rows with an icon, never hover-only.
- **Dense but readable.** Body text is 14px, data labels 12–13px, and nothing is below 11px.
  Tabular figures go on every number. Monospace is used only for code-like content (the search
  DSL, résumé/LaTeX sources, ATS slugs, job types).

## Tokens

Dark is the `:root` base. Light applies when the OS asks for it
(`@media (prefers-color-scheme: light) :root:not([data-theme="dark"])`) or when the user picks it
(`:root[data-theme="light"]`). The theme toggle in the header cycles system → light → dark. The
choice is kept in `localStorage["jobflow-theme"]` (try/catch), and an inline `<head>` script
applies it before first paint (no flash).

### Colour: Radix slate / indigo / grass / blue / amber / red

| token | light | dark | role |
|---|---|---|---|
| `--bg` | `#f7f7f9` | `#111113` | page |
| `--surface` | `#ffffff` | `#18191b` | cards, panels, inputs |
| `--surface-2` | `#f0f0f3` | `#212225` | subtle fill, hover, table head |
| `--surface-3` | `#e8e8ec` | `#272a2d` | selected / pressed neutral |
| `--border` | `#e0e1e6` | `#2e3135` | card edges, dividers (decorative) |
| `--border-strong` | `#cdced6` | `#363a3f` | button/chip edges |
| `--control-border` | `#80838d` | `#696e77` | input edges (≥ 3:1, WCAG 1.4.11) |
| `--text` | `#1c2024` | `#edeef0` | primary text |
| `--text-2` | `#50555d` | `#b0b4ba` | secondary text |
| `--text-3` | `#62666f` | `#9a9ea6` | tertiary text, captions, placeholders |
| `--accent-solid` / `-hover` | `#3e63dd` / `#3358d4` | same | primary buttons, focus, active nav |
| `--accent-text` | `#3a5bc7` | `#9eb1ff` | links, selected chips |
| `--accent-soft` / `-border` | `#edf2fe` / `#abbdf9` | `#182449` / `#3a4f97` | tonal fills |
| `--good` `--info` `--warn` `--bad` | `#287a39` `#0b68b8` `#975700` `#b8262b` | `#71d083` `#70b8ff` `#ffca16` `#ff9592` | semantic text/icons |
| `--*-soft` / `--*-border` | Radix step 3 / 7 | Radix step 3 / 7 | semantic fills/edges |
| `--focus` | `#3e63dd` | `#8da4ef` | 2px focus ring, 2px offset |

### Measured contrast (WCAG 2.2; AA text ≥ 4.5, UI ≥ 3)

| pair | light | dark |
|---|---|---|
| text on bg / surface | 15.3 / 16.4 | 16.3 / 15.2 |
| text-2 on bg / surface / surface-2 | 7.0 / 7.5 / 6.6 | 9.1 / 8.5 / 7.6 |
| text-3 on bg / surface / surface-2 | 5.4 / 5.8 / 5.1 | 7.0 / 6.6 / 5.9 |
| accent-text on surface | 6.0 | 8.5 |
| white on accent-solid (primary button) | 5.2 | 5.2 |
| good / info / warn / bad on surface | 5.3 / 5.7 / 5.7 / 6.3 | 9.3 / 8.4 / 11.5 / 8.4 |
| good / info / warn / bad on its own soft fill | 4.8 / 5.1 / 5.5 / 5.5 | 7.9 / 7.1 / 10.3 / 7.8 |
| accent-text on accent-soft (selected chip) | 5.4 | 7.3 |
| control-border on surface (inputs) | 3.8 | 3.4 |
| focus ring on surface | 5.2 | 7.3 |

Recompute after any palette change (a 20-line relative-luminance script is enough). Text pairs
must stay ≥ 4.5 in both themes.

### Type

Fonts are Inter (UI, `--font-sans`) and JetBrains Mono (code-ish, `--font-mono`), both through
`next/font/google` and self-hosted at build.

| token | px | use |
|---|---|---|
| `--fs-xs` | 12 | badges, captions, table heads |
| `--fs-sm` | 13 | secondary text, buttons, chips |
| `--fs-base` | 14 | body |
| `--fs-md` | 15 | brand, emphasized body |
| `--fs-lg` | 17 | card titles, panel titles |
| `--fs-xl` | 20 | stats, sub-page titles |
| `--fs-2xl` | 26 | page title (h1) |

Weights are 400/500/600, plus 650–700 for titles and scores. Line height is 1.5 for body and 1.25
for headings.

### Space, shape, elevation

The spacing scale is on a 4px grid: `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 ·
`--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40 · `--s-12` 48.

- Radii: `--r-sm` 6 (badges, small buttons) · `--r-md` 8 (buttons, inputs) · `--r-lg` 12 (cards,
  panels) · `--r-full`.
- Control heights: `--h-sm` 28 · `--h-md` 34 · `--h-lg` 40. On `pointer: coarse`, buttons grow to
  40px and chips to 36px.
- Shadows: `--shadow-sm` (resting card), `--shadow-md` (hover, menus), `--shadow-lg` (drawer,
  toast).
- Layout: `--header-h` 56 (52 on mobile) · `--gutter` 24 (16 at ≤ 640px) · `--content-max` 1080 ·
  `--wide-max` 1400 · `--rail-w` 272.

## Components (class → React wrapper)

| class | wrapper (`components/ui`) | notes |
|---|---|---|
| `.btn` + `--primary/secondary/tonal/ghost/danger`, `--sm/--lg`, `--icon`, `--block` | `Button`, `ButtonLink`, `btn()` | one primary per view region |
| `.chip` (`aria-pressed`/`data-on`), `.chip--warn` | `Chip` | toggles: filters, choices |
| `.badge` + `--neutral/accent/good/info/warn/bad`, `--estimate` | `Badge` | static facts; tone = meaning |
| `.field`, `.field__label`, `.field__hint`, `.input/.select/.textarea`, `.check` | `Field` | every control has a label (wrapping `<label>` or `aria-label`) |
| `.banner` + `--info/good/warn/bad` | `Banner` (`live` → `role=status`/`alert`) | async notices are live regions |
| `.panel` (`--warn/--bad`), `.panel__head/__title/__desc/__actions` | `Panel` | h2 under the page h1 |
| `.page`, `.page--wide`, `.page-header`, `.page-title` | `PageHeader` | exactly one h1 per page |
| `.empty` | `EmptyState` | icon, title, body, action |
| `.skeleton` | `Skeleton` | pair with a live "loading" message |
| `.segmented` | `Segmented` | view switches (aria-pressed, not ARIA tabs) |
| `.stat`, `.stats` | `Stat` | tabular numbers |
| `.table` / `.table__head` / `.table__row` | — | grid rows; restack to cards ≤ 760px |
| `.section-nav` | `SectionNav` | sticky in-page TOC; becomes a scroll strip ≤ 1100px |
| `.app-header`, `.app-nav` | `AppShell` (`components/ui/AppShell.tsx`, rendered by `app/layout.tsx`) | THE nav — items/order from `lib/nav.ts` (UX_AUDIT §1); skip link, `aria-current="page"` (secondary routes light their parent), disclosure menu ≤ 900px |
| `.page`, `.page-header` | `AppFrame` (`components/AppFrame.tsx`) | thin wrapper over `PageHeader` for pages: `title`/`intro`/`eyebrow`/`actions`, `wide`; renders no nav |
| `.ux-*` (setup checklist, hidden-by-filters report, Job page facts/apply options/copy box, syntax table, save bar) | — | journey surfaces, `globals.css` §12, tokens only |
| `.filter-rail` | `FilterDrawer` | sticky rail; a modal sheet ≤ 960px (Esc, backdrop, focus return) |
| `.match` | `MatchCard` | the product: see below |
| `.toast` | — | inside an `aria-live` wrapper |

Legacy class names (`.card-block`, `.save`, `.cmd`, `.tag`, `.field-row`, `.reg-row`, …) are
aliased onto these primitives in `globals.css`. Untouched markup still renders in the system, but
new code should use the canonical names.

### Match card anatomy

```
┌──────┬──────────────────────────────────────────────── archetype · #presets ┐
│  92  │ Title (h2)                                                          │
│ ▬▬▬  │ Company · Location (⚠ amber if us/eu-only) · verify? · ✓ in CRM      │
│      │ [● 2d] [greenhouse · ATS-direct] [low trust 31%] [~2–5 yrs] [~₹30L–45L · est 62%] │
│      │ stack  Primary language java — direct match.                        │
│      │ level  …                                                            │
│      │ ⚠ red flag rows (amber) / ⊘ invalidated (red)                       │
│      │ skill skill skill                                                   │
├──────┴──────────────────────────────────────────────────────────────────────┤
│ save  archive  invalid                              [tailor] [track] [Apply ↗]│
└──────────────────────────────────────────────────────────────────────────────┘
```

The scan path runs score → title → company/location → caveats → actions. On phones the manage
buttons collapse to icons (labels stay for screen readers), and Apply fills the row.

## Accessibility checklist

- The focus ring is a 2px `--focus` outline with a 2px offset on `:focus-visible` (WCAG 2.4.11/2.4.13).
- The skip link goes to `#main`. Landmarks are `header` / `nav[aria-label=Primary]` / `main` /
  `footer`. Headings run in order: h1 (page) → h2 (panels, cards).
- No click handlers on non-interactive elements. Toggles expose `aria-pressed`, and menus expose
  `aria-expanded` and `aria-controls`.
- Async results, sync state, saves, and queued jobs are announced via `aria-live="polite"` or
  `Banner live`.
- `prefers-reduced-motion` turns off animations and transitions. Nothing relies on motion.
- At 375px wide nothing scrolls horizontally (the screenshot script warns on overflow), and
  gutters are 16px.
