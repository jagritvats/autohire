# JobFlow videos

A reproducible pipeline for JobFlow's launch videos: the narrated walkthrough, the trailer,
two short guides and three vertical reels. Everything shown is **fictional demo data**
(`JOBFLOW_DEMO_DATA=1`: invented companies, boards and candidates); nothing is fetched from
real job boards. Generated media is **never committed**. It goes to `$VIDEO_OUT` (default
`.video/` at the repo root, which git ignores). Transcripts with chapter times live in
[`docs/guides/video-walkthrough.md`](../../docs/guides/video-walkthrough.md).

| Video | Spec | Narration | Output |
|---|---|---|---|
| Walkthrough (~3.5 min) | `specs/walkthrough.mjs` | `narration/walkthrough.json` | `jobflow-walkthrough.mp4` |
| Trailer (~50 s) | `specs/trailer.mjs` | `narration/trailer.json` | `jobflow-trailer.mp4`, `.captioned.mp4`, `.square.mp4` |
| Guide: get started | `specs/guide-start.mjs` | `narration/guide-start.json` | `jobflow-guide-get-started.mp4` |
| Guide: MCP / Claude Code | `specs/guide-mcp.mjs` | `narration/guide-mcp.json` | `jobflow-guide-mcp.mp4` |
| Reels (3 × ~30 s, 1080×1920) | `specs/reels.mjs` | `narration/reels.json` | `reels/jobflow-reel-*.mp4` |

Every video also gets an `.srt` caption file and a `.poster.png`.

## What you need

- `pnpm install && pnpm -r build` (the web app must be built: the pipeline runs `next start`).
- Playwright with Chromium (`pnpm add -Dw playwright && npx playwright install chromium`, or
  `JOBFLOW_CHROMIUM=/path/to/chrome`).
- `ffmpeg` with libx264, libass and loudnorm (any recent build), and util-linux `script`
  (for the terminal captures).
- `ELEVENLABS_API_KEY` in the environment, only for narration or music that isn't cached
  yet. **Never** put the key in a file in this repo, in a script, or on the command line where
  it is logged; the scripts read it from the environment only. Narration is cached per line
  (by model + voice + settings + text), so changing one line costs one call, and changing the
  model or a voice setting regenerates every line it touches.
- Network for Google Fonts (title cards and captions) and the xterm.js CDN (terminal scenes).

## Regenerate

```bash
export VIDEO_OUT=$PWD/.video              # or anywhere outside the repo
export ELEVENLABS_API_KEY=…               # from your secret store; only for new lines

# 1. real terminal sessions and MCP tool output (a throwaway copy of the repo + a throwaway home)
node scripts/video/capture-cli.mjs --fresh
node scripts/video/capture-mcp.mjs

# 2. everything: narration → timeline → scenes → MP4 + .srt + poster
pnpm video all                            # = node --import tsx scripts/video/make.mjs all

# one video, or re-record a few scenes, or only re-assemble after a narration tweak
node --import tsx scripts/video/make.mjs walkthrough --only feed,filters
node --import tsx scripts/video/make.mjs trailer --steps tts,assemble

# 3. transcripts with chapter times → docs/guides/video-walkthrough.md
node scripts/video/transcript.mjs

# docs/screenshots/cli-*.png from the same fictional captures (step 1)
node scripts/video/cli-shots.mjs

# 4. look at it: a contact sheet at every scene boundary and mid-scene
node scripts/video/frames.mjs $VIDEO_OUT/out/jobflow-walkthrough.mp4 $VIDEO_OUT/work/walkthrough/timeline.json
```

`--import tsx` is needed because the apply scenes run the real form-filler
(`@jobflow/autofill`, TypeScript source) on a fictional form.

The web app runs on `VIDEO_PORT` (default 3407) in its own process group and is stopped when
the run ends. `--draft` suffixes the outputs with `.draft`.

## How it works

- **Narration first.** `lib/timeline.mjs` turns each scene's lines into TTS clips (ElevenLabs
  **Eleven v4**, `eleven_v4`, with character timestamps) and lays them out: a lead-in, the lines
  with gaps, a tail. Scene lengths come from the voice, so picture and sound stay in sync.
  A line can have `say` (what the voice reads, e.g. "p-n-p-m") apart from `text` (the caption).
  The model is set per narration file (`"model"`) or per spec (`model`); the default is
  `eleven_v4`. Voices: George (`JBFqnCBsd6RMkjVDRZzb`) for the walkthrough, trailer and guides,
  Jessica (`cgSgspJ2msm6clMCkdW9`) for the reels.
- **Audio tags.** v4 follows inline tags such as `[warm]`, `[calm]`, `[confident]`,
  `[excited]` and `[short pause]`; they steer delivery and are not spoken. Use them lightly (at
  most one or two per line). The timestamp alignment still lists a tag's characters, so
  `lib/tts.mjs` drops them: captions, the `.srt`, the reels' word-by-word captions and the
  transcripts never show tag text, and each word keeps its own spoken times
  (`node --test scripts/video/test/*.test.mjs`). `qa-tts.mjs` checks the cached narration
  without calling the API: speaking rate per line, and that each tag's span in the alignment
  is short or silent (a long `[short pause]` span should be a real, quiet pause).
- **Live scenes** (`lib/live.mjs`, `lib/record.mjs`): the built web app in demo mode, driven
  by Playwright at 1536×864 CSS px × 1.25 (1920×1080 output; reels: 360×640 × 3 = 1080×1920),
  captured with a CDP screencast, with a visible cursor, click ripples, eased pointer moves
  and smooth scrolling. Actions wait for their narration line (`at(line, offset)`). Spotlights,
  chapter pills and the "stopped at the review screen" note are video annotations injected
  for the recording, styled apart from the app.
- **Demo sync and search.** In demo mode a sync "fetches" the fictional boards with paced,
  real progress events (`packages/service/src/demo-corpus.ts`) and a search asks them, so the
  sync panel and search results never show real postings.
- **The review gate** scenes run the real `fillPlanOnPage` (what `jobflow apply --fill`
  runs) on a fictional employer form (`pages/apply-form.html`), paced so each field can be
  seen. It fills and stops; there is no submit code path, and the scene fails if the form
  were ever submitted.
- **Terminal scenes** replay sessions captured by `capture-cli.mjs` in a pseudo-terminal
  (`script` with byte timing) in xterm.js (`pages/terminal.html`), with real timing and long
  waits compressed. Commands are typed; output is the real output. Scratch paths show as `~`.
  The `git clone` step is shown typed but not run (its output is skipped, marked `⋯`).
- **The MCP conversation** (`pages/chat.html`) is an *illustrative* chat in a neutral layout,
  labelled as such; every tool result in it is real `jobflow mcp` output from
  `capture-mcp.mjs`, and the assistant's words only restate those results.
- **Title cards** (`pages/card.html`) use the app's Editorial style (paper `#f6f1e7`, ink
  `#1c1915`, vermilion `#b8401c`; Fraunces + Schibsted Grotesk) and are rendered frame by
  frame on a virtual clock, so animation timing is exact. If `brand/` holds a wordmark SVG,
  cards use it.
- **Sound** (`lib/audio.mjs`): narration placed at its timeline times, an ElevenLabs music
  bed (generated once per mood and cached, never third-party music) ducked under the voice,
  synthesized whooshes on the trailer's cuts, and two-pass loudness normalisation to -16 LUFS.
- **Captions** (`lib/captions.mjs`): `.srt` from the TTS word timings; burned-in captions for
  the trailer's social cuts and word-by-word highlighted captions for the reels (kept clear
  of the top 250 px and bottom 400 px).

## Editing

Change words in `narration/*.json` (keep them plain and honest: JobFlow never submits, never
auto-applies, and only the optional local agent reads logged-in sites). Change what's on
screen in `specs/*.mjs`. Re-run `make.mjs` for the videos you touched, then `qa-tts.mjs` and
`transcript.mjs`.
