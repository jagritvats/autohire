# Legal & ethics

JobFlow automates parts of a job search. Automation that touches other people's websites
carries real obligations, so the design draws hard lines — and some decisions stay with you.
This page explains both. It is not legal advice.

## The four execution tiers

| Tier | What | Where it runs | Default |
|---|---|---|---|
| 1 | Official / public JSON APIs: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday CXS, RSS/JSON feeds you add | Cloud worker, web server, CLI | on |
| 2 | Public, low-risk pages and APIs with polite pacing: aggregators, community "who's hiring" threads | Cloud worker, web server, CLI | on |
| 3 | Sites that require a login or are hostile to automation: LinkedIn, Naukri, Glassdoor, AmbitionBox, Darwinbox boards | **Only the local agent, on your own machine, in your own browser session** | **off** |
| 4 | Paid data providers (optional) | wherever you configure them | off |

The cloud never runs Tier 3 and never holds your session for those sites. This is enforced
in code (the adapter registry, the job runtime routing, and tests), not just by convention.

## What JobFlow will not do

- **Submit an application.** The form-filler stops at the review screen, every time. There
  is no flag, setting or code path that clicks submit; `JOBFLOW_AUTOSUBMIT` is hard-wired to
  false. Reviewing what is sent in your name is the point.
- **Invent facts about you.** Résumé tailoring, answers and cover letters are rewritten only
  from your own résumé, Evidence Bank and declared skills. Résumé import copies text from
  your file; any model-assisted extraction is filtered so nothing absent from the source
  survives.
- **Evade anti-bot measures.** No CAPTCHA solving, TLS fingerprint spoofing, residential
  proxies or parallel sessions. The local agent browses at human pace through a normal
  browser profile you are logged into.
- **Share your data.** Everything lives in your own database or data directory. On a
  multi-user instance, other users never see your profile, evidence, drafts, applications,
  saved searches, custom sources or keys. Postings and the company registry are a shared
  public corpus.

## Your responsibilities

- **Terms of service.** Many sites — LinkedIn in particular — prohibit automated access in
  their terms, even for your own account. Enabling a Tier-3 source is your decision and your
  risk; that is why every Tier-3 source is opt-in, per source, behind two switches (a machine
  flag and a web toggle).
- **Rate limits and robots.txt.** Keep the default pacing. If you add a custom feed or board,
  make sure you are allowed to poll it, and don't lower the poll cadence below what the
  source can reasonably serve.
- **Attribution.** Salary benchmarks from levels.fyi are shown with attribution; keep it.
- **Hosting for others.** If you run a shared instance (`JOBFLOW_AUTH=password`), you are
  operating a service that stores other people's résumés and contact details. Use HTTPS,
  keep backups private, set `JOBFLOW_SECRET_KEY` so stored LLM keys are encrypted, and
  publish your own privacy notice.

## Data minimisation

- Résumé uploads are stored outside the source tree (`JOBFLOW_DATA_DIR`, default
  `~/.jobflow`) and never committed; the repository's PII guard fails CI if a personal file
  or identity marker appears in tracked files.
- API keys and tokens are write-only in the UI: tokens are stored as hashes, and the LLM key
  is encrypted at rest when `JOBFLOW_SECRET_KEY` is set.
- Deleting a saved search or a custom source stops future polling; postings it found expire
  through the normal freshness sweep.
