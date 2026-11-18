# JobFlow brand

The logo, app icons, posters, share images and brand sheet, with the sources and scripts
that build them. Everything here follows the app's **Editorial** style
([`docs/internal/DESIGN.md`](../docs/internal/DESIGN.md)): warm paper and ink, one vermilion
accent, Fraunces for display, Schibsted Grotesk for text, hairline rules.

**Start with the [brand sheet](brand-sheet.pdf)** ([PNG](brand-sheet.png)): usage, clear
space, sizes, colour with contrast, type, do and don't.

## The mark

A **J and a full stop** on a tile. JobFlow finds jobs, ranks them honestly and fills the
form, and then it stops. The next move is yours, so the stop carries the accent, the colour
that means "you can act here" everywhere in the product. The tile reads as an index entry
(the product is a ranked index of jobs), and the stop is the review gate.

- The J is Fraunces (SOFT 100, WONK 0), outlined. There are two optical masters, like
  Fraunces' own optical-size axis: **display** (weight 700, opsz 72) for 48 px and up, and
  **text** (weight 800, opsz 9, a bigger stop) for 16 to 32 px.
- The stop always takes the accent of the surface it sits on: **ember `#ef7a4f` on the ink
  tile**, **vermilion `#b8401c` on the paper tile**.
- One stop per lockup. The wordmark (`Job` roman + `Flow` italic) carries its own stop only
  when it stands alone.
- Clear space: a quarter of the tile's height on every side. Smallest sizes: mark 16 px / 5 mm,
  horizontal lockup 20 px / 6 mm tall.

## Files

### Logo: `logo/` (outlined SVG, no fonts needed)

| file | use |
|---|---|
| `jobflow-horizontal.svg` · `-dark` · `-mono-black` · `-mono-white` | the default lockup: tile + wordmark |
| `jobflow-stacked.svg` · `-dark` · `-mono-black` · `-mono-white` | square-ish spaces |
| `jobflow-wordmark.svg` · `-dark` · `-mono-black` · `-mono-white` | the wordmark alone, with its stop |
| `jobflow-mark.svg` · `-dark` · `-mono-black` · `-mono-white` | the tile alone (display master) |
| `jobflow-mark-small.svg` · `-small-dark` | the tile at 16 to 32 px (text master) |
| `geometry.json` | the mark's path data, used by the icon builder and the web app |

`light` (no suffix) is for paper or other light grounds (an ink tile); `-dark` is for night or
other dark grounds (a paper tile). The mono files knock the J and stop out of a one-colour tile.

### Icons: `icons/`

| file | size | wired into |
|---|---|---|
| `favicon.ico` | 16 / 32 / 48 | `apps/web/app/favicon.ico` |
| `favicon.svg` | any; ink tile on light chrome, paper tile on dark (`prefers-color-scheme`) | `apps/web/app/icon.svg` |
| `apple-touch-icon.png` | 180, full bleed | `apps/web/app/apple-icon.png` |
| `icon-192.png` · `icon-512.png` | PWA, rounded tile | `apps/web/public/icons/`, listed by `apps/web/app/manifest.ts` |
| `icon-maskable-512.png` | PWA maskable, art inside the 80 % safe circle | same |
| `extension/icon-{16,32,48,128}.png` | MV3 (128 has Chrome's 16 px padding) | `apps/extension/icons/`, `manifest.json` `icons` + `action.default_icon` |

The web app's header draws the mark inline (`apps/web/components/ui/AppShell.tsx`, path data
in `brandMark.ts`, generated) from theme tokens: the tile is the header's ink
(`currentColor`), the J is masked out of it, and the stop is the accent mixed toward the page
colour (or a style's `--brand-mark-dot`: Spark uses its coral). So the same markup works in
Editorial, Classic and Spark, light and dark.

### Posters: `posters/`

Three posters, each as an **A3 print PDF with 3 mm bleed** (303 × 426 mm page; trim to
297 × 420 mm, keep type 15 mm inside the trim; no crop marks, add them at the printer if
needed), the **trimmed A3 page as a 2× PNG** (2245 × 3175), and a **4:5 social crop**
(1080 × 1350 at 2×: 2160 × 2700).

| poster | message |
|---|---|
| `poster-ranked-*` | "Every job, ranked by how well it fits *you*." Two real match cards, and what a card tells you. |
| `poster-review-gate-*` | "It fills the form. *You* press submit." A real `jobflow apply --fill` result, stopped before submit, and the real dry-run output. |
| `poster-local-*` | "Open source. Runs on your machine. Your data stays *yours*." Night paper, the real `jobflow feed` output, the quick start. |

### Social and repo: `social/`

| file | size | use |
|---|---|---|
| `github-social-preview.png` | 1280 × 640 | GitHub → repo Settings → Social preview (upload by hand) |
| `og-image.png` | 1200 × 630 | Open Graph / Twitter card; copied to `apps/web/app/opengraph-image.png` and `twitter-image.png` (+ `.alt.txt`) |
| `readme-banner-light.png` · `-dark.png` | 2560 × 800 (1280 × 400 @2×) | the README hero, chosen with `<picture>` + `prefers-color-scheme` |
| `launch-1-match-cards.png` | 1080 × 1080 | launch post: honest match cards |
| `launch-2-pay.png` | 1080 × 1080 | launch post: pay, stated vs estimate |
| `launch-3-mcp.png` | 1080 × 1080 | launch post: works with Claude Code and other MCP clients |

## Honest imagery

Every product image is the real product run on **fictional data**: the offline demo corpus
(`packages/service/src/demo.ts`: Acme Pay, Initech Labs, …) and the invented candidate Alex
Example. Terminal blocks are the real CLI output, with one edit: the long scratch path of the
demo résumé is shown as `…/`. The filled form is a real `fillPlanOnPage` run against a local
test form; the capture script fails if the form was submitted. The copy makes no claim the
product doesn't: it never says JobFlow applies for you, because it doesn't.

## Licences

- **Artwork** (everything in `logo/`, `icons/`, `posters/`, `social/`, the brand sheet and the
  HTML/CSS in `src/`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit
  "The JobFlow contributors". The licence covers the artwork; it doesn't let you use the name
  or mark to suggest that a different product is JobFlow or endorsed by it.
- **Scripts** in `scripts/`: AGPL-3.0-only, like the rest of the repository.
- **Fonts**: Fraunces, Schibsted Grotesk and JetBrains Mono are under the
  [SIL Open Font License 1.1](https://openfontlicense.org), which allows outlining glyphs into
  artwork (the logo SVGs contain outlines, not a font) and embedding subsets in documents (the
  PDFs). The fonts are fetched from npm (`@fontsource-variable/fraunces@5.3.0`,
  `@fontsource-variable/schibsted-grotesk@5.3.0`, `@fontsource-variable/jetbrains-mono@5.3.0`)
  into `brand/.fonts/` with their licence files and aren't committed. Glyphs those subsets lack
  (the rupee sign, arrows in terminal output) fall back to system fonts (DejaVu Sans Mono, Inter).

## Regenerate

From the repository root:

```bash
pip install fonttools brotli uharfbuzz pillow pyoxipng   # Python 3.10+
bash brand/scripts/fetch-fonts.sh                         # fonts -> brand/.fonts
python3 brand/scripts/build_logo.py                       # logo/*.svg, geometry.json, apps/web/components/ui/brandMark.ts
node brand/scripts/build_icons.mjs                        # icons/, favicon.ico, copies into apps/web and apps/extension

pnpm install && pnpm -r build                             # the CLI and the built web app
node brand/scripts/capture.mjs                            # fictional captures -> brand/.out/captures (port 3507)
node brand/scripts/render.mjs [filter]                    # posters/, social/, brand-sheet.*, the app's OG image
python3 brand/scripts/optimize.py brand/posters/*.png brand/social/*.png brand/brand-sheet.png \
  apps/web/app/opengraph-image.png apps/web/app/twitter-image.png   # lossless
```

Rendering uses Playwright's Chromium (`require("playwright")`, falling back to a Chromium under
`$PLAYWRIGHT_BROWSERS_PATH`). The sources are plain HTML in `src/` (`brand.css` holds the
tokens); open one in a browser to work on it. Posters switch layout with
`body[data-format="a3" | "social"]`. `capture.mjs` needs the web app built and port 3507 free;
it starts the app in its own process group and stops it when done. `optimize.py --quantize`
(256 colours) suits flat artwork only: it shifts the colours of product captures.
