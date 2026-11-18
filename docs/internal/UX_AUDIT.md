# UX audit and target journeys (web + CLI)

Status: the target design for the v0.2 journeys overhaul. Sections 1–3 are the contract the
visual layer (AppShell, `components/ui/**`) is wired to. The rest is the audit and its reasoning.

## 1. Navigation and information architecture (wire this into the AppShell)

Primary nav. Order follows the job seeker's loop. The labels are final; `apps/web/lib/nav.ts`
exports the same list as data (`NAV`), so the shell can render it without copying it.

| # | Label | Route | What it answers |
|---|---|---|---|
| 1 | **Jobs** | `/` | "What should I look at today?" The ranked feed, your saved-search views as tabs, Saved and Hidden collections, the setup checklist. |
| 2 | **Search** | `/search` | "Find me X right now." Live search, examples, preset tags, save as a view. |
| 3 | **Applications** | `/applications` | "Where am I with each one?" The tracker: stage, next step, due follow-ups. |
| 4 | **Profile** | `/profile` | "Who am I to JobFlow?" Résumé, details, skills, what you want, Evidence Bank, reusable answers. |
| 5 | **Sources** | `/sources` | "Where does it look?" Presets, your own sources with last-run status, the company list, sync. |
| 6 | **Settings** | `/settings` | Model (LLM), applying and the local agent, data and cache, API tokens. |

Secondary (not in the nav):

| Route | Reached from |
|---|---|
| `/jobs/[id]` | **Job page.** A card's title, `o` on the feed, a search result, an application row. It holds the full JD, the fit breakdown, tracker status, drafts, the apply checklist and actions. |
| `/tailor/[postingId]` | The Job page "Tailor" action, `t` on the feed. |
| `/company/[id]` | The company name on a card or job page. |
| `/companies` | Sources → "All companies" (the old "registry"). |
| `/onboarding` | The first visit, the checklist, Profile → "Re-import résumé". |
| `/login`, `/signup` | Hosted mode only. |

Old routes redirect to the new ones: `/searches` → `/search`, `/discovery` → `/sources`.

Account menu (hosted mode only) sits at the end of the nav. Status, such as "syncing…" or
"in-memory: nothing is saved", belongs in the shell header and not in the nav.

## 2. Target journeys (jobs to be done)

A person running JobFlow locally works through this loop:
**set up who I am → find good roles → understand fit honestly → prepare a strong
application → apply → keep track and follow up.**

### J1. First run (web)
1. On a blank profile, `/` shows real jobs **unscored** (browse mode). Above them sits a
   **Get started** checklist:
   1. Add your résumé → `/onboarding`
   2. First sync (automatic; shows progress)
   3. Save a search
   4. Track an application

   The "model (optional)" item lives in Settings and does not block anything.
2. `/onboarding` has four steps: **Résumé** (upload, paste, *or type your skills instead*, or the
   fictional sample) → **Review** (contact, skills, years and level, evidence to keep) →
   **Preferences** (where you can work, pay floor, role types) → **Where to look**
   (presets, pre-selected from your home country, multi-select). Every step says what
   happens next, and nothing is saved until "Finish".
3. Finish leads to `/` with a "Building your feed…" state that **polls by itself** and swaps
   in the ranked feed. It never asks the user to "refresh in a minute".
4. Failures are stated plainly, each with a way forward:
   - An unreadable PDF: "couldn't read text, try paste or DOCX".
   - No network during sync: "No sources answered. Check your connection, then Sync again".
   - No model: say what is unavailable and that everything else works.

### J2. First run (CLI)
- Bare `jobflow` prints a **status screen**: profile, corpus with its last sync, saved
  searches, tracked applications, the model, and **one next step**. It does not dump the
  full help (clig.dev: "suggest what to run next").
- `jobflow init` runs interactively, or with `--yes` plus flags.
  - `--yes` with nothing to go on (no résumé, skills or sample) **refuses** with exit 2 (usage) and
    names the flags to pass. It does not save an empty profile and rank against it.
- Commands that need a profile say so and give the command to run, with exit 4.
- Unscored output (before `init`) never shows profile-relative notes ("you're mid", "not in
  your stack") and never hard-excludes. A blank profile has no floor and no location.

### J3. Daily loop
Open **Jobs**:
- A tab per view: All, plus one per saved search, then Saved and Hidden.
- Filters are views. **Every filter reports what it hid**, for example "7 hidden by
  filters: 4 work mode, 3 min score · clear filters". Scores never change.
- Keyboard: `j`/`k` move, `o` opens, `t` tailors, `a` applies, `s` saves, `x` hides, `?` lists
  the keys.

From a card or Job page, the next actions are always in view: **Save, Tailor, Apply,
Track**. The Job page's **Apply panel** is a checklist (email, name, résumé file, cover
letter) with a fix link for each gap, then:
- **Open application form**
- **Pre-fill on this computer**, which shows the exact `jobflow apply <id> --fill` command,
  or queues the local agent when it's online
- **I submitted it → mark applied**

The never-submit guarantee is written as a promise ("You always press submit"), not as a
warning.

**Applications** rows link back to the Job page and to Tailor. Follow-ups that are due sit
on top. An empty pipeline links to Jobs and Search.

### J4. Search
- A plain search box. Below it are example chips ("backend engineer remote",
  "data engineer Berlin posted:7d"…) and preset tags. A disclosure lists the full query
  syntax, which matches the CLI.
- Results report what was fetched, from which sources, what the query hid (per reason) and
  how many were hard-excluded (with the reason).
- Zero results suggest how to loosen the search: drop a filter, widen the posted window,
  remove the location.
- **Save as view** names the search and gives "Open in Jobs" (`/?view=<id>`). Saved
  searches are listed with last run, results and "Run now".
- Before onboarding, results are unscored and the page says so.

### J5. Discovery (Sources)
- Presets are cards you switch on and off, each with a company and feed count. Their feeds
  can be toggled.
- **Add a source** takes one input that accepts a URL or a company name. Validation errors
  are written in plain language.
- Each source shows its **last run**: when, how many postings, or the error.
- "All companies" opens the company list. **Sync now** shows progress here. Operator
  commands (discover, poll, re-rank, enrich, recheck, purge) move here from the feed.

### J6. Profile and Settings
**Profile** is a single page with an in-page section nav, a sticky "Save changes" bar that
shows dirty state, and re-ranking on save. Sections:
- Résumé
- Contact
- Skills & level
- What you want
- About you
- Evidence Bank
- Connected context
- Reusable answers

**Settings** sections:
- Model: provider, key, **Test connection**, and what "echo" means: "offline; ranking and
  résumé templates work, prose is off".
- Applying: the form-filler, the local agent and the tier-3 opt-ins.
- Data: the cache and re-poll.
- API tokens.

### J7. Tailor → apply
- Each draft card labels its source: **"From your résumé (template)"** for builtin and
  **"Written by <model>"** for a model draft. Stale drafts say why.
- "Use this for the application" attaches it, and the Job page's Apply checklist then shows
  it as attached.
- From Tailor, **"Next: Apply →"** leads to the Job page's apply panel.

### J8. States everywhere
| State | Pattern |
|---|---|
| Loading | Skeleton or "Loading…", never "No results". |
| Empty | What this place is for, plus the action that fills it (NN/g: a learning cue and a direct path). |
| Error | What failed, why if known, and what to do next. |
| Success | What changed, plus the next step. |

## 3. CLI command map (target)

```
jobflow                      status + the one next step (was: bare help)
jobflow status               same, explicitly; --json for scripts
jobflow init                 set up (interactive) · --yes with flags · --sample
jobflow search <q> [flags]   live search, scored · --save-as
jobflow sync | rank          fill / re-score the corpus
jobflow feed [--search v]    ranked feed · views report hidden counts
jobflow show <ref>           one job in full
jobflow tailor <ref>         grounded drafts
jobflow apply <ref>          checklist + dry run · --open · --fill (never submits)
jobflow track [...]          the pipeline · next actions
jobflow profile|me|evidence|config|discovery|searches|doctor|serve
```

Kept: exit codes 0/1/2/3/4, `--json` on stdout with hints on stderr, row-number refs.

## 4. Audit: what we found (before)

Walked on 2026-11-18. The web app ran against the built demo corpus
(`JOBFLOW_DEMO_DATA=1`, echo model) and the CLI against a fresh `--data-dir`.

### Highest impact
1. **No job page.** The card is "the product", but there was nowhere to read the full JD,
   see the tracker status, drafts and apply readiness together, or move from a card to the
   next step except "Apply →" (external) and "tailor". Search results and the pipeline
   rows had no link back to the posting.
2. **The nav differed on every page.** The feed showed six links, Search five, Discovery
   five (a different five), Pipeline six, Registry three, and Settings and Tailor only
   "← feed". Labels mixed product language ("pipeline", "registry") with internals.
3. **Feed filters hid cards silently.** About ten rail filters (archetype, mode, geo, trust,
   years, "honesty"…) removed cards with no count of what they hid. That breaks the "views
   always report what they hid" invariant in spirit.
4. **The feed was an operator console.** It carried the "COMMAND: Discover / Poll all /
   Re-rank / Enrich comp / Recheck all" bar, "maintenance: recheck all / remove old", an
   "invalid" action on every card, an activity log, and a stats bar of "companies / active
   postings / hard-excluded". A job seeker needs none of these on the page they read every
   day.
5. **The first sync was a dead end.** The page said "Fetching jobs… refresh in a minute",
   with no auto-refresh and no failure state when nothing came back.
6. **Settings was one long form.** Résumé, LaTeX, connected context, evidence, a fixed
   33-skill chip list (custom skills couldn't be added), comp, archetypes, geo, location
   weights, contact, a mid-page "Save profile", drafts, cache, the LLM, tokens and
   automation, with three different save buttons.
   - **Home country and markets could not be edited at all** after onboarding.
   - It linked to a `docs/SETUP.md` that doesn't exist.
   - It hard-coded India ("Browse good-paying roles in India"; INR first in the currency
     list) for every user.
7. **The CLI's unscored search made claims about an empty profile.** Before `init`, `jobflow
   search backend` printed "fit: Primary language java is a real stretch from your stack",
   "Asks senior, you're mid", and "35 hard-excluded (stated pay below your floor, or a
   location you can't work from)". The blank profile has no stack, floor or location.
8. **`jobflow init --yes` with no input saved an empty profile** and marked it onboarded.
   The feed was then "ranked" against nothing, the exact invented score the product promises
   never to show.
9. **`jobflow apply` marked the tracker "ready" even when nothing could be filled.** That
   happened with no email, no name and no résumé, alongside a list of fixes.
10. **Bare `jobflow` printed the full help** instead of where you are and what to do next.

### Medium
- Web search required CLI flag syntax (`--remote --loc Berlin,DE`) typed into a box. It had
  no examples to click, no zero-results guidance, and no "Open in Jobs" after saving.
- Onboarding:
  - It couldn't continue without a résumé file or text (only the fictional sample).
  - Home country and markets were free-text ISO codes with no suggestion.
  - Presets weren't pre-selected from the home country.
- Pipeline:
  - "fill" silently queued a local-agent job, which did nothing when no agent ran.
  - There was no feedback and no CLI alternative.
  - Rows linked to the company, not the job.
- Card copy used internal terms ("ATS-direct", "in CRM", "archetype", "§11.3" in hints,
  "tier-1 · cloud-safe").
- Tailor offered "← feed" as its only way out, with no "next: apply".

### Low
- The "in-memory" durability pill sat inside the nav.
- The Tailor and Settings headers had no nav.
- The footer was fine.

## 5. Research notes (what we borrowed)
- **clig.dev:** respond within 100 ms (spinner); suggest the next command; say what changed;
  provide a state-showing command (→ `jobflow` / `jobflow status`); never require a prompt
  (flags for everything, `--yes`); send primary output to stdout and messages to stderr;
  write errors in plain language with the fix; reserve distinct exit codes.
- **NN/g on empty states:**
  - Never leave a blank panel.
  - Don't show "no results" while loading.
  - Give an in-context learning cue plus a direct path to the task.
  - Offer a "learn more" or demo-data option (→ the fictional sample).
- **Huntr and Teal trackers:** stages run from Bookmarked/Wishlist → Applied → Interview →
  Offer, and the job record is the hub. Teal seeds sample jobs so first-run isn't empty.
  We keep "Saved" as the first stage and the Job page as the hub.
- **Simplify Copilot:** the user fills the form, reviews every page, then presses the
  employer's Submit. Its help docs warn that reused answers can carry stale company names.
  We say the same on the review gate, and we never offer an auto-submit tier.
- **Otta (now Welcome to the Jungle):** preferences come first, and users can filter out what
  they don't want. Users complained when changing preferences later was hard. This is why
  "What you want" is a first-class Profile section that stays editable.

Sources: [clig.dev](https://clig.dev/),
[NN/g: designing empty states](https://www.nngroup.com/articles/empty-state-interface-design/),
[Huntr job tracker](https://huntr.co/product/job-tracker),
[Teal: getting started with the job tracker](https://help.tealhq.com/en/articles/9508859-getting-started-job-tracker),
[Simplify: using Copilot to autofill](https://help.simplify.jobs/articles/2415391-using-copilot-to-autofill-applications),
[Fortune on Otta](https://fortune.com/2022/02/07/this-job-search-site-is-trying-to-be-the-solution-to-the-great-resignation-by-prioritizing-picky-candidates/).

## 6. What changed (after)
See the "Changes" section appended at the end of this document.
