# JobFlow v0.1.0

**A local-first job search engine.** JobFlow finds roles across hundreds of company boards,
ranks them against *your* résumé with honest match cards, tailors your documents from your
own material, and pre-fills applications — then stops so you can review and submit.

![The ranked feed](https://raw.githubusercontent.com/jagritvats/jobflow/v0.1.0/docs/screenshots/feed.png)

## Get started

```bash
git clone https://github.com/jagritvats/jobflow.git && cd jobflow
pnpm install && pnpm -r build
pnpm jobflow init                                 # your résumé + preferences, reviewed by you
pnpm jobflow search "backend engineer" --remote   # live search, scored against you
pnpm jobflow sync && pnpm jobflow feed            # your ranked feed
pnpm jobflow apply 1 --fill                       # pre-fill; you review and submit
```

No account, no server and no API keys needed. Data stays in `~/.jobflow`.

## Highlights

- **ATS-first discovery** across Greenhouse, Lever, Ashby, Workday and a dozen more, plus
  aggregators and community channels; presets for India, Global remote, US and Europe & UK
  (pick several), and your own companies, feeds and channels on top.
- **Honest match cards** — why it fits, stack distance with a real ramp estimate, stated vs.
  estimated pay, red flags like US-only "remote". Only two hard exclusions.
- **Live search and saved searches** with filters that say what they hid and never rescore.
- **Résumé import** (PDF, DOCX, LaTeX, Markdown, JSON Resume, LinkedIn export) that copies,
  never invents.
- **Grounded tailoring** and an **autofill that never submits** — enforced in code and by a
  real-browser test.
- A **CLI**, a **web app**, a scheduled **worker**, a **local agent** for logged-in sites and a
  **browser extension**. Optional multi-user hosting mode.

See the [CHANGELOG](https://github.com/jagritvats/jobflow/blob/v0.1.0/CHANGELOG.md) for the
full list and the [docs](https://github.com/jagritvats/jobflow/tree/v0.1.0/docs) to dig in.

## Licence

GNU AGPL-3.0-only. Use it privately however you like; if you distribute it or run a modified
version as a service for others, share your source under the same licence.
