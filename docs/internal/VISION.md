# JobFlow — Vision

*One surface that finds the right jobs, judges them honestly, preps you, and assists the apply — all driven by configuration you own, not code you edit.*

---

## The one-line

JobFlow is a **personal job-hunt operating system**: a single web control plane where you tune what you want (stack, comp, locations, targets), watch an honest ranked feed assemble itself, and dispatch the heavy lifting — polling boards, enriching ratings, browsing LinkedIn/Naukri, filling forms — without ever leaving the page or touching a terminal.

The CLI exists for developers and cron. **The product is the web app.** If a user has to run a command, that's a gap.

---

## Three product truths (unchanged, load-bearing)

1. **Finding is the foundation.** ATS APIs are the ghost-free spine; aggregators + HN feed discovery; the detector resolves names → boards. Volume is not the goal — *the right roles, fresh, deduped* is.
2. **Honest recommendations are the differentiator.** Almost nothing is a hard filter. A Java dev sees Go/Scala/Node roles because the systems core transfers, and the card says so plainly: *"primary language Go — transferable, ~2wk ramp; your Kafka depth covers the hard part."* Every comp number carries a confidence tag. Every "remote" that's secretly US-only is flagged, not hidden. **The match card is the product.**
3. **Autofill stops at review.** Max automation up to a human gate, never a submit. The review screen *is* the value.

---

## The shift this vision adds: from pipeline to control plane

Today the pipeline runs from a CLI/cron and the web shows a snapshot. The vision is the inverse: **the web app is the brain and the dashboard; everything is configured and triggered there, and it persists.**

What "managed from the web" means concretely:

- **Your profile is data you edit, not seed code.** Tech stack, expected comp + floor, location weights (ranked, not binary), target archetypes, remote-geo tolerance, the Evidence Bank — all editable in a settings UI. Change your stack, the feed re-ranks. (§6.1: *"configurable means these are data, edited in a settings UI, not code."*)
- **The registry is yours to curate.** Add a target by name or careers URL (the detector resolves it), tag it, set its poll cadence, hit "poll now," pause or drop it.
- **Company intelligence is on the card.** Ratings (overall / WLB / comp), review counts, an honest culture summary, interview difficulty — surfaced inline and in a company detail view.
- **You dispatch work from buttons, not commands.** "Re-poll now," "enrich top matches," "start LinkedIn browse," "fill this application" — all are buttons that enqueue jobs and stream status back.
- **The application CRM lives here.** Status pipeline, don't-double-apply guard, reminders, conversion analytics that feed back into ranking.

---

## The architecture that makes it safe: two planes, one database

You asked to start LinkedIn/Naukri browsing *from the web*. The honest, durable way to do that respects the **tier boundary** (the project's #1 invariant): **the cloud never holds your LinkedIn/Naukri/Glassdoor session.** So the system is two cooperating planes that communicate only through the shared database — never by sharing a browser session:

```
        ┌──────────────────────────────────────────────┐
        │  CONTROL PLANE  (web + cloud worker)          │
        │  • the brain: config, matching, the corpus    │
        │  • Tier 1–2 only: ATS APIs, aggregators, HN   │
        │  • enqueues jobs; renders the feed + CRM      │
        └───────────────┬──────────────────────────────┘
                        │  jobs ⇅ results  (Postgres / Supabase)
        ┌───────────────┴──────────────────────────────┐
        │  LOCAL AGENT  (your machine, your sessions)   │
        │  • the hands: Tier 3 + form-fill              │
        │  • LinkedIn/Naukri/Glassdoor/AmbitionBox      │
        │  • Playwright fill → review gate, never submit│
        │  • flag-guarded OFF by default                │
        └──────────────────────────────────────────────┘
```

- The **control plane** is the brain: it holds your config, runs the legal/free Tier 1–2 ingestion + matching, and presents everything. It can run in the cloud (Vercel + Supabase) or on your VPS.
- The **local agent** is the hands: a small companion process on your machine that authenticates to the app, watches for jobs tagged `runtime=local`, runs them *in your own browser session at human pace*, and writes results back. The web "Start LinkedIn browse" button doesn't browse — it **enqueues a job the local agent picks up.** If the agent is offline, the button tells you so.

This is the same line as multi-tenancy (§6.1): in a multi-user world, *each tenant's* local agent uses *their* sessions; the server orchestrates and never holds anyone's credentials. **Tier and tenancy are the same boundary** — and it's what lets "browse LinkedIn from the web" be safe instead of a bot-farm trap.

---

## Configurability as a first-class principle

Behavior is driven by two editable records, never by redeploys:

- **`profile`** (per user): stack, YoE/level, the Evidence Bank, and `prefs` (salary floor, location weights, target archetypes, remote-geo tolerance).
- **`tenant_config`** (per user): which sources are enabled, poll cadence, automation flags (browser on/off, which Tier-3 sources are opted in), LLM choice, digest cadence.

A settings change is a data write that triggers a re-rank. The matcher, the enrichment gate, the digest, and the local agent all read these. "Configurable" is not a feature bolted on — it's the substrate.

---

## Honesty is the brand, encoded as invariants

These aren't just engineering rules; they're what make the product trustworthy enough to act on:

- **Evidence-grounded generation** — every bullet/answer cites a real project. No name-dropping unknowns. (The fix for the tryhard/Cartesia failure.)
- **Soft weights, not gates** — only two hard exclusions ever (salary floor, impossible location). Everything else is surfaced with a flag.
- **Never auto-submit** — layered gates; the review screen is the value.
- **Confidence on every number** — a modeled salary is never shown as fact.

A user trusts JobFlow because it tells them the gap, the red flag, and the real geo — not because it flatters the match.

---

## What the daily loop feels like (the test of "done")

Morning: open JobFlow. The digest shows 6 new high-match roles since yesterday and 2 follow-ups due. You scan cards — honest fit notes, comp with confidence, ratings, watch-flags. You tweak your stack to add "rust" (a weekend project paid off); the feed re-ranks live. You hit **enrich** on the top 5 → ratings + India comp fill in (your local agent, already running, does the Tier-3 work). One role is perfect: you hit **tailor** (3 grounded resume variants + a drafted "why here"), then **fill** → your local agent opens the Greenhouse form in your browser, fills it, and stops at review. You read, edit, submit. JobFlow logs it, sets a follow-up reminder, and won't let you double-apply.

No terminal. No spreadsheet. One honest surface.

---

## North-star principles (for every future decision)

1. **The web is the only required surface.** A feature that needs the CLI isn't done.
2. **The cloud never holds a scrape-hostile session.** Tier 3 is local, always.
3. **Configuration is data.** If changing behavior needs a code edit, it's a bug.
4. **Honest by construction.** Flags over hiding; confidence over false precision; review over auto-submit.
5. **One type system, one source of truth.** `@jobflow/core` from adapter to UI to agent.
6. **Single-user-first, multi-tenant-shaped.** Never build a wall that a second user would force you to tear down.

See **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** for how we get from today's read-only feed to this control plane, phase by phase.
