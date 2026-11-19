# JobFlow web — design system

The visual contract for `apps/web`. The shared structure CSS is `apps/web/app/globals.css`;
each visual style's tokens and component overrides are in `apps/web/app/styles/<style>.css`;
React wrappers are in `apps/web/components/ui/`. If you add UI, compose these. Don't add
bespoke colours or sizes.

The app has **three styles** on one component tree (next section): **Editorial** (Concept A,
"Editorial light" — the default), **Classic** (the "calm ledger" system it replaced) and
**Spark** (Concept B). They share the class names, primitives, semantic tones, component
anatomy and accessibility rules; the palette, type, shape and some page layouts differ. Each
style's own section below keeps its reasoning and tokens.

## Styles

### How the switch works

- **Style × theme.** `<html data-style="editorial|classic|spark">` sits next to the theme's
  `data-theme` (`light`, `dark`, or absent for "follow the OS"). Six combinations, every one
  measured (table below). Settings → Appearance picks the style (three small live preview cards)
  and the theme; the header toggle still cycles the theme, and the two stay in sync through a
  `jobflow:theme` window event.
- **No flash.** The server renders `data-style="editorial"`. An inline `<head>` script
  (`STYLE_INIT_SCRIPT` in `lib/style.ts`, next to `THEME_INIT_SCRIPT` in `lib/theme.ts`) sets a
  saved style before first paint. Both scripts live in plain modules: a server component that
  imports a constant from a `"use client"` file gets a client reference, not the string.
- **Persistence.** Per browser, like the theme: `localStorage["jobflow-style"]` (the default is
  stored as "no choice"), every access in try/catch. There's no cookie, because the theme has
  none and the head script makes one unnecessary. It isn't saved to the account.
- **Fonts.** `app/layout.tsx` loads all five families through `next/font/local` (variable woff2 files committed in `app/fonts/`, each with its OFL licence) as CSS variables
  (`--font-fraunces`, `--font-schibsted`, `--font-inter`, `--font-jakarta`, `--font-jbmono`).
  Each style's tokens pick theirs (`--font-sans`, `--font-display`, `--font-mono`). Only
  Editorial's faces are preloaded. A browser downloads the others only when a style uses them.

### How the CSS is organised

| file | holds |
|---|---|
| `app/globals.css` | everything the three styles share: layout, components and states written against tokens only, unscoped |
| `app/styles/editorial.css`, `classic.css`, `spark.css` | that style's tokens (light + dark) and component overrides, every selector scoped `:where([data-style="<style>"]) …` |

`:where()` adds no specificity, so a style's rule competes with a shared rule exactly as it did
when each style was a single sheet: by specificity, then by order. The style sheets load after
`globals.css`. A style rule that a **later** shared rule must still beat would win wrongly
there, so those few rules sit inline in `globals.css`, scoped, right where the cascade needs
them. Classic and Spark also define Editorial's token names (`--rule`, `--font-display`,
`--fs-2xs`, `--tracking-caps`, `--measure`, `--read-max`, …) in their own terms. A shared rule
written against any token therefore renders in every style.

When you add UI:

- Put structure and anything token-driven in `globals.css`, unscoped. It then looks right in all
  three styles. Check it in each one (Settings → Appearance, or
  `node scripts/screenshots.mjs --only styles`).
- Put a look that only one style has in that style's sheet, scoped. If a shared rule after it
  must still win a tie, put it inline in `globals.css`, scoped.
- Never add a second component tree or page per style. Express markup differences as data
  plus CSS (below).

### One component tree, three presentations

| piece | markup (rendered for every style) | Editorial | Classic | Spark |
|---|---|---|---|---|
| match score | `ScoreRing` → `.match__score` › `.score-ring` (svg ring + `.score-num` + `.score-ring__word`) + `.score-meter` | serif numeral over a band-colour rule | numeral + meter bar | ring around the numeral + the band's word |
| Jobs header | `.feed-hero`: `Dateline`, `.feed-hero__eyebrow`, h1, `TodayLede`, stats incl. `.stat--shown` and `.feed-hero__extra` chips; numbers from `todaySummary()` (`lib/today.ts`) | dated masthead + one-sentence lede + shown/total | title + shown/total | "Today" hero + count chips (new this week, great matches, follow-ups due) |
| empty state | `EmptyState` → `.empty__art` (svg drawing + icon tile) | italic serif line, no art | icon tile | the drawing + floating tile |

A style hides what it doesn't draw (`display: none`, so it's out of the accessibility tree too)
and flattens wrappers it doesn't need (`display: contents` on presentational spans only, never on
an element that carries a role). The score keeps one accessible name in every style ("Match
score 92 of 100, a great match").

### Measured contrast, all six combinations (WCAG 2.2; text ≥ 4.5, UI ≥ 3)

| pair | Editorial light | Editorial dark | Classic light | Classic dark | Spark light | Spark dark |
|---|---|---|---|---|---|---|
| text on bg / surface / surface-2 | 15.6 / 16.8 / 14.4 | 15.8 / 14.9 / 13.6 | 15.3 / 16.4 / 14.4 | 16.2 / 15.2 / 13.7 | 16.6 / 17.9 / 15.9 | 17.3 / 16.1 / 14.7 |
| text-2 on bg / surface / surface-2 | 8.2 / 8.8 / 7.5 | 10.6 / 10.0 / 9.2 | 7.0 / 7.5 / 6.6 | 9.1 / 8.4 / 7.6 | 8.5 / 9.1 / 8.1 | 11.1 / 10.3 / 9.4 |
| text-3 on bg / surface / surface-2 | 5.8 / 6.3 / 5.4 | 7.0 / 6.6 / 6.1 | 5.4 / 5.8 / 5.1 | 7.0 / 6.5 / 5.9 | 6.2 / 6.7 / 5.9 | 7.7 / 7.2 / 6.5 |
| accent-text on bg / surface / accent-soft | 5.7 / 6.1 / 5.2 | 8.5 / 8.1 / 7.0 | 5.6 / 6.0 / 5.4 | 9.1 / 8.5 / 7.3 | 7.1 / 7.6 / 6.6 | 9.1 / 8.5 / 7.4 |
| accent-on on accent-solid (primary button) | 5.5 | 6.5 | 5.2 | 5.2 | 6.4 | 6.0 |
| good on bg / surface / good-soft | 5.8 / 6.3 / 5.4 | 9.9 / 9.3 / 8.1 | 5.0 / 5.3 / 4.8 | 9.9 / 9.3 / 7.9 | 5.0 / 5.4 / 4.8 | 11.0 / 10.2 / 8.6 |
| info on bg / surface / info-soft | 6.2 / 6.7 / 5.7 | 9.0 / 8.5 / 7.7 | 5.3 / 5.7 / 5.1 | 9.0 / 8.4 / 7.1 | 5.7 / 6.1 / 5.4 | 9.5 / 8.8 / 7.8 |
| warn on bg / surface / warn-soft | 5.7 / 6.2 / 5.3 | 10.9 / 10.3 / 9.1 | 5.3 / 5.7 / 5.5 | 12.3 / 11.5 / 10.3 | 5.8 / 6.2 / 5.7 | 12.6 / 11.8 / 10.2 |
| bad on bg / surface / bad-soft | 6.7 / 7.2 / 5.8 | 8.5 / 8.0 / 7.3 | 5.9 / 6.3 / 5.5 | 9.0 / 8.3 / 7.7 | 5.6 / 6.1 / 5.3 | 9.0 / 8.4 / 7.6 |
| spark-text on surface / spark-soft | — | — | — | — | 5.8 / 5.2 | 10.0 / 8.5 |
| control-border on bg / surface (UI) | 3.4 / 3.7 | 4.2 / 3.9 | 3.5 / 3.8 | 3.7 / 3.4 | 3.2 / 3.5 | 4.4 / 4.1 |
| focus ring on bg / surface (UI) | 4.9 / 5.3 | 8.5 / 8.1 | 4.9 / 5.2 | 7.8 / 7.3 | 5.9 / 6.4 | 9.1 / 8.5 |
| score ring great / good / stretch on surface (UI) | — | — | — | — | 3.5 / 4.7 / 3.8 | 9.0 / 7.4 / 7.8 |
| Spark header: white / `#f1ecff` on the lightest gradient stop | — | — | — | — | 5.7 / 4.9 | 5.7 / 4.9 |

All values were computed from the style sheets' token blocks with the WCAG relative-luminance
formula. Recompute after any palette change and update this table in the same PR. Every style
keeps the 2px `--focus` ring with a 2px offset (Spark's is pill-safe, and white inside its brand
bar), stops animations and transitions under `prefers-reduced-motion`, and has no horizontal
scroll at 375px.

### Tokens per style

- **Editorial:** see [Concept A](#concept-a--editorial-light) below. Light (paper) is the base;
  dark is "night paper".
- **Classic:** see [Calm ledger](#calm-ledger-classic) below. Dark is the base and light
  follows the OS or the toggle. Inter, the Radix slate/indigo/grass/blue/amber/red scales.
- **Spark:** see [Concept B](#concept-b--spark) below. Dark is the base. Plus Jakarta Sans,
  violet/coral, `--brand-gradient`, the score ring tokens.

## Concept A — "Editorial light"

The Editorial style, and the default.

### Rationale

The calm-ledger pass fixed contrast and hierarchy, but it still looked like every other dark
SaaS dashboard: neutral greys, an indigo accent, a box around everything. JobFlow is something
a person *reads* every morning during a stressful search, so Concept A sets it like a good
paper instead of a control panel:

- **Paper and ink.** Light is the base theme: a warm paper ground (`#f6f1e7`) and near-black
  ink (`#1c1915`). Dark is "night paper", a warm charcoal (`#161411`) rather than blue-black,
  with every role re-measured. Both themes are first-class; the toggle and the OS choose.
- **Type does the hierarchy.** A characterful display serif, **Fraunces** (optical size and
  "soft" axes), sets page titles, section heads, card headlines and, above all, the **score
  numerals**, which are the visual anchor of each match. A newsroom grotesk, **Schibsted
  Grotesk** (drawn for a media group's screens), sets everything you read and press.
  **JetBrains Mono** stays for code-like content only. All three are self-hosted by
  `next/font/local` from `app/fonts/`. A build needs no network and there is no font CDN at runtime.
- **Rules instead of boxes.** Sections open with a hairline (or, under a page title, an ink
  rule) and a serif head, not a bordered card. Match cards are entries in an index, with
  hairlines between them. Tables are open, with an ink rule on top. The only framed surface is
  the temporary "Get started" checklist, because it is scaffolding, not content.
- **One confident accent.** Vermilion (`#b8401c` light, `#ef7a4f` dark) means "you can act
  here": primary buttons, links, the active nav rule, the current step, the selection mark. It
  is never used for status. The semantic tones keep their meaning. `bad` moved to a crimson
  (`#a31d3c`) so it stays distinct from the accent, and danger buttons are outlined while
  primary buttons are solid.
- **Calm tags.** A neutral fact is a hairline frame with no fill, and a toned fact gets its tint.
  Skills read as a run of words ("java · kafka · postgres"), not a wall of pills. Chips that
  are on get an ink frame and a tick (plus `aria-pressed`), which stays calm even with a dozen
  on. An estimate still always looks like an estimate: a dashed frame, `~`, and `est N%`.
- **Editorial moments.** Jobs opens with a dated masthead and a one-sentence lede ("1 new match
  since yesterday. The strongest of 17: Backend Engineer, Ledger at Acme Pay, 92."). The count
  is postings whose source date is within a day. Unscored lists never claim a "strongest". The
  Job page is laid out as an article: the fit summary is the lede, and "stack / level / likely
  gap / check before applying" are typeset sub-sections. The full description flows as the
  body, beside a sticky fact sheet (the big score, one fact per line, Apply / Save / Tailor, the
  status). Empty states are an italic serif line plus a sentence and the way on, with no
  clip-art.

References studied for direction (not copied): serif-led "warm editorial" product systems
(cream paper, terracotta accent, a serif kept to headings and key metrics), newsroom
typography (small-caps datelines and kickers, ruled section heads, "continued on" lines), and
Craft-style ink-on-paper canvases.

### Tokens

| token | light | dark | role |
|---|---|---|---|
| `--bg` | `#f6f1e7` | `#161411` | page (paper) |
| `--surface` | `#fcfaf5` | `#1d1a16` | inputs, menus, drawer, the checklist |
| `--surface-2` / `-3` | `#efe8da` / `#e6ddcc` | `#25221d` / `#2e2a24` | tints: hover, code, pressed |
| `--border` | `#e2d9c8` | `#35302a` | hairline rules (decorative) |
| `--border-strong` | `#cdc2ad` | `#4a433b` | section rules, chip and button edges |
| `--rule` | `#1c1915` | `#f2ede3` | the ink rule under a page title, a table, a fact sheet |
| `--control-border` | `#8c8170` | `#80776a` | input edges (≥ 3:1) |
| `--text` / `-2` / `-3` | `#1c1915` / `#4d473f` / `#645c51` | `#f2ede3` / `#cdc4b5` / `#a99f90` | ink, secondary, captions |
| `--accent-solid` / `-hover` | `#b8401c` / `#9f3615` | `#ef7a4f` / `#f58e67` | primary buttons, focus, the active rule |
| `--accent-on` | `#ffffff` | `#1c1410` | text on a primary button |
| `--accent-text` / `-soft` / `-border` | `#a83a19` / `#f8e3d6` / `#e5ab92` | `#f59a74` / `#3a2016` / `#8a4329` | links, datelines, tonal fills |
| `--good` / `--info` / `--warn` / `--bad` | `#2c6a33` `#205e86` `#895200` `#a31d3c` | `#86cf8c` `#7fbde3` `#efc15a` `#ff8fa0` | semantic text and icons |
| `--*-soft` | `#e3eedb` `#dfeaf0` `#f6e9c9` `#f6dde0` | `#1c2a1c` `#152530` `#2f2310` `#3a1720` | semantic tints |
| `--focus` | `#b8401c` | `#f59a74` | 2px focus ring, 2px offset |

Shape: `--r-sm` 3 · `--r-md` 4 · `--r-lg` 6 for surfaces, and `--r-full` pills only for things
you press (buttons, chips). Shadows are gone from resting surfaces (`--shadow-sm: none`). Only
menus, the drawer and toasts lift. Layout: `--header-h` 64 (56 mobile), `--gutter` 32
(16 at ≤ 640px), `--content-max` 1120, `--read-max` 720, `--measure` 68ch, `--rail-w` 264.

### Measured contrast (WCAG 2.2; AA text ≥ 4.5, UI ≥ 3)

| pair | light | dark |
|---|---|---|
| text on bg / surface / surface-2 | 15.6 / 16.8 / 14.4 | 15.8 / 14.9 / 13.6 |
| text-2 on bg / surface / surface-2 | 8.2 / 8.8 / 7.5 | 10.6 / 10.0 / 9.2 |
| text-3 on bg / surface / surface-2 / surface-3 | 5.9 / 6.3 / 5.4 / 4.9 | 7.1 / 6.6 / 6.1 / 5.5 |
| accent-text on bg / surface / accent-soft | 5.7 / 6.1 / 5.2 | 8.5 / 8.1 / 7.0 |
| accent-on on accent-solid (primary button) | 5.5 | 6.5 |
| good / info / warn / bad on bg | 5.8 / 6.2 / 5.7 / 6.7 | 9.9 / 9.0 / 10.9 / 8.5 |
| good / info / warn / bad on their soft tint | 5.5 / 5.7 / 5.3 / 5.8 | 8.1 / 7.7 / 9.1 / 7.3 |
| control-border on surface / bg | 3.7 / 3.4 | 3.9 / 4.2 |
| focus ring on bg / surface | 4.9 / 5.3 | 8.5 / 8.1 |

### Type scale

| token | px | face | use |
|---|---|---|---|
| `--fs-2xs` | 11 | grotesk, 600–700, caps +0.08em | datelines, kickers, table heads, fact labels |
| `--fs-xs` | 12 | grotesk | badges |
| `--fs-sm` | 13 | grotesk | secondary text, buttons, chips |
| `--fs-base` | 15 | grotesk | body |
| `--fs-md` | 16 | grotesk | page intros, the job description (line height 1.7) |
| `--fs-lg` | 20 | Fraunces 500, opsz 36 | card headlines, option heads |
| `--fs-xl` | 26 | Fraunces 450, opsz 72 | section heads (h2) |
| `--fs-2xl` | 44 (34 mobile) | Fraunces 400, opsz 144 | page title (h1); Jobs uses 52 |
| `--fs-score` | 46 (38 mobile) | Fraunces 350, lining tabular | score numeral on a card |
| `--fs-score-lg` | 88 (56–64 mobile) | Fraunces 300 | score numeral on the Job page |

Ledes (the Jobs masthead, the fit summary) are Fraunces 350 at 21–23px. Empty-state titles
are Fraunces italic at 32px. The score numeral is ink for a strong match, secondary for a fair
one, and tertiary for a weak one. A 2px rule under it carries the band colour (green / blue /
grey), so strength reads in type weight and colour, never in colour alone.

### Where it lives

Tokens and Editorial-only rules are in `app/styles/editorial.css` (the Jobs masthead, the Job
page article grid, Applications figures, onboarding steps, presets, the Tailor grounding strip);
what Editorial shares with the other styles is in `globals.css`. Its markup hooks are
`Dateline` and `TodayLede` in `FeedView.tsx` and the section class hooks in `JobView.tsx`
(`ux-fit`, `ux-apply`, `ux-drafts`, `ux-desc`, `ux-dismiss`). The other styles don't
draw the dateline or the lede.

## Concept B — "Spark"

The Spark style: a bold, colourful, consumer-grade product feel, built on the same tokens and
primitives. Its tokens and overrides are in `app/styles/spark.css`.

### Rationale

- **Energy without noise.** The last overhaul was correct but read as "the same" neutral dark
  tool. Spark keeps the information density and the honesty rules, and adds a brand: an
  electric violet with a warm coral spark, a gradient brand bar, round friendly shapes and
  soft tinted shadows. Trend research (2026 consumer UI round-ups: rounded cards, pill
  buttons, vivid gradient accents; glassmorphism considered and rejected for readability)
  informed the direction; the palette, mark and motifs are original.
- **Colour still means something, and never alone.** Violet = you can act here. Emerald /
  azure / amber / rose keep the `good` / `info` / `warn` / `bad` meanings. Coral is decoration
  and the "stretch" score band only. Every coloured signal also carries a word or an icon
  (score ring + number + "great/good/stretch", ✓ on selected chips, ⚠ on flags, `~ … est N%`
  on estimates).
- **The score is a ring.** A 0–100 arc in the band colour around the number, with the band
  word underneath (`ScoreRing`; great ≥ 78 emerald, good 60–77 azure, stretch < 60 coral).
  The same thresholds as before; one accessible name ("Match score 92 of 100, a great match").
- **A "today" hero on Jobs.** Eyebrow, the h1, and stat chips derived from data already on the
  page: new this week (≤ 7 days), great matches, follow-ups due (links to Applications), jobs
  in your list, left out by pay/location. Other pages open on the same hero card (wash +
  h1 + intro), so every page shares one rhythm.
- **Drawn empty states.** `EmptyState` renders a small inline-SVG scene (two cards on a tinted
  blob, a mini score ring, sparkles) with the state's own icon on a brand tile — theme tokens
  only, no assets, `aria-hidden`.
- **Motion with a job.** The ring draws in (900ms), selected chips pop their ✓, cards lift 2px
  on hover, buttons press to 97%, notices and the mobile menu rise in, the empty-state tile
  floats. All of it stops under `prefers-reduced-motion` (durations → 0, hover transforms off).

### Palette (dark is `:root`; light via the OS or the toggle)

| token | light | dark | role |
|---|---|---|---|
| `--bg` | `#f7f5fc` | `#0e0b1a` | page (a faint violet tint) |
| `--surface` / `-2` / `-3` | `#ffffff` / `#f3f0fa` / `#e9e4f6` | `#171329` / `#201b36` / `#2a2442` | cards, fills, pressed |
| `--border` / `-strong` | `#e7e2f3` / `#d6cfea` | `#2c2645` / `#3b3459` | decorative edges |
| `--control-border` | `#8c84a8` | `#7a72a0` | input edges (≥ 3:1) |
| `--text` / `-2` / `-3` | `#18132e` / `#4a4463` / `#5f5878` | `#f3f0fd` / `#c6c0de` / `#a59fc0` | text |
| `--accent-solid` → `--accent-solid-2` | `#6633ee` → `#8a35e0` | `#6a3cf0` → `#8a35e0` | `--button-gradient`: primary buttons, selected chips/nav |
| `--accent-text` / `-soft` / `-border` | `#5a2bd6` / `#f0ebff` / `#cbbcff` | `#b9a4ff` / `#251a4d` / `#4e38a6` | links, tonal fills |
| `--spark` / `-text` / `-soft` | `#ff7a45` / `#b43d0e` / `#fff0e8` | `#ff8a5c` / `#ffad8a` / `#3a1d14` | warm secondary (decor, "stretch") |
| `--good` / `--info` / `--warn` / `--bad` | `#0b7a50` / `#0a63b0` / `#925000` / `#c0193f` | `#5ad9a3` / `#72bbff` / `#ffc857` / `#ff8fa8` | semantic text + icons |
| `--score-great` / `-good` / `-stretch` | `#0f9d63` / `#2f6fe4` / `#e0561f` | `#3ccf8e` / `#5aa9ff` / `#ff8a5c` | ring strokes |
| `--focus` | `#6633ee` | `#b9a4ff` | 2px ring, 2px offset (white inside the brand bar) |
| `--brand-gradient` | `#4b1fd1 → #6a2ae0 → #8b2fd6 → #b8306f` | same | the header (same chrome in both themes) |

Inside `.app-header` the colour tokens are re-pointed at a light-on-brand set (`--text` white,
`--text-2/-3` `#f1ecff`, translucent surfaces, pale semantic tones), so anything rendered in the
header — theme toggle, account menu, a sync/status pill — stays legible with no bespoke colour.
The active nav item is a white pill with `#5a2bd6` text.

### Measured contrast (WCAG 2.2; text ≥ 4.5, UI ≥ 3)

| pair | light | dark |
|---|---|---|
| text on bg / surface | 16.6 / 17.9 | 17.3 / 16.1 |
| text-2 on bg / surface-2 / surface-3 | 8.5 / 8.1 / 7.4 | 11.1 / 9.4 / 8.4 |
| text-3 on bg / surface / surface-2 / surface-3 | 6.2 / 6.7 / 5.9 / 5.4 | 7.7 / 7.2 / 6.5 / 5.8 |
| white on accent-solid / accent-solid-2 (gradient ends) | 6.4 / 5.7 | 6.0 / 5.7 |
| accent-text on surface / accent-soft / surface-2 | 7.6 / 6.6 / 6.8 | 8.5 / 7.4 / 7.7 |
| good / info / warn / bad on surface | 5.4 / 6.1 / 6.2 / 6.1 | 10.2 / 8.8 / 11.8 / 8.4 |
| good / info / warn / bad on own soft fill (badges, ring word) | 4.8 / 5.4 / 5.7 / 5.3 | 8.7 / 7.8 / 10.2 / 7.6 |
| spark-text on surface / spark-soft ("stretch") | 5.8 / 5.2 | 10.0 / 8.5 |
| count pill (`#1d0c05` on spark) | 7.3 | 8.2 |
| control-border on surface (UI) | 3.5 | 4.1 |
| focus on surface / bg (UI) | 6.4 / 5.9 | 8.5 / 9.1 |
| ring strokes great / good / stretch on surface (UI) | 3.5 / 4.7 / 3.8 | 9.1 / 7.4 / 7.8 |
| header: white on darkest / lightest gradient stop | 8.7 / 5.7 | same |
| header: `#f1ecff` on lightest stop; active nav on white | 4.9; 7.6 | same |

### Type — Plus Jakarta Sans (UI) + JetBrains Mono (code-like only)

Both through `next/font/local` from `app/fonts/` (variable files: Jakarta 200–800). Jakarta's
word space is narrow, so `body` adds `word-spacing: 0.05em`. Numbers use tabular figures.

| token | px | use |
|---|---|---|
| `--fs-xs` | 12 | badges, captions, uppercase rail labels (700, +0.05em) |
| `--fs-sm` | 13 | secondary text, buttons, chips |
| `--fs-base` | 14 | body (line-height 1.55) |
| `--fs-md` | 15 | page intros, hero stat values |
| `--fs-lg` | 18 | panel titles (800); card titles are 19px/800 |
| `--fs-xl` | 22 | stats |
| `--fs-2xl` | 30 | page h1 (800, −0.03em) |
| `--fs-3xl` | 36 | the Jobs hero h1 |

### Shape, space, elevation

- Radii: `--r-sm` 8 · `--r-md` 12 (inputs, flags, banners) · `--r-lg` 20 (cards, panels) ·
  `--r-xl` 28 (hero cards) · `--r-full` (buttons, chips, badges, segmented, nav, search bar).
- Controls: `--h-sm` 30 · `--h-md` 38 · `--h-lg` 44 (40 minimum on coarse pointers; the search
  bar is 48).
- Shadows are tinted violet in light (`--shadow-sm/md/lg`), deeper black in dark; primary
  buttons and selected states add `--shadow-brand`.
- Layout: `--header-h` 60 (56 on phones) · `--gutter` 28 (16 at ≤ 640px) · `--rail-w` 292 (the
  filter rail floats as its own rounded card; a 360px sheet ≤ 960px).

### New / changed primitives

| piece | where | notes |
|---|---|---|
| `ScoreRing` (`.score-ring`, `--md`/`--lg`) | `components/ui/primitives.tsx` | `scoreBand()` + `SCORE_WORD`; tested in `apps/web/test/style.test.ts` |
| `EmptyState` art (`.empty__art`) | same | inline SVG, tokens only |
| `Stat` tones `accent` / `info` / `warn` | same | hero stat chips |
| `.feed-hero`, `.stat-link` | `styles/spark.css` | Jobs "today" hero |
| skill pills | `.match__skill` | dot + name; they make no have/learn claim (the stack note does) |

## Calm ledger (Classic)

The Classic style. Its tokens and overrides are in `app/styles/classic.css`; the tables below
are its values.

### Rationale

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
`next/font/local` from `app/fonts/` (committed, no network at build).

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
