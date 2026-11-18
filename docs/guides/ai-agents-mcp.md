# Use JobFlow from Claude Code and other AI agents (MCP)

`jobflow mcp` runs JobFlow as a [Model Context Protocol](https://modelcontextprotocol.io)
server. Claude Code, Claude Desktop or any other MCP client can then search jobs, read your
ranked feed, look at one role in full, track applications, plan an application and draft
grounded documents through JobFlow, on the same local data as the CLI and the web app.

## Why

Plenty of tools now "score jobs and tailor a résumé" inside an AI agent, usually by having the
agent scrape job boards and improvise. JobFlow's value is the data layer underneath:

- **ATS-first discovery.** Roles come straight from employers' Greenhouse / Lever / Ashby /
  Workable … boards and public feeds, with India coverage built in, not from scraped search
  pages.
- **Freshness.** Re-polling bumps `lastSeen`. Roles a board stops listing are retired, and so
  are links that are definitely gone. The earliest posting date is kept, so a reposted role
  doesn't look new.
- **Honest scores.** Each role gets a 0–100 fit against your profile with flags: stack fit,
  level, red flags, and stated pay vs a labelled estimate. Only two things are hard filters.
  A query is a view, and what it hides is counted.
- **Grounded writing.** Drafts rest on your base résumé, Evidence Bank and declared skills.
  They are rephrased, reordered and trimmed, never extended.

Over MCP an agent queries that layer instead of scraping the web. You still review every
application and submit it yourself.

## Set it up

You need a working checkout (`pnpm install && pnpm -r build`) and, ideally, a profile
(`pnpm jobflow init`, or `pnpm jobflow init --sample` to try the fictional demo persona).
Without a profile everything still works, but jobs come back unscored.

### Claude Code

```bash
claude mcp add jobflow -- node /path/to/jobflow/apps/cli/bin/jobflow.mjs mcp
```

or, if `pnpm` works from any directory on your machine:

```bash
claude mcp add jobflow -- pnpm -s --dir /path/to/jobflow jobflow mcp
```

Add `--scope user` to make it available in every project, and `-e JOBFLOW_DATA_DIR=/path` to
use a data directory other than `~/.jobflow`. Check it with `claude mcp list`, or with `/mcp`
inside Claude Code.

The `node …/jobflow.mjs` form is the most robust. It doesn't depend on which directory the
client starts it from. Under Corepack, `pnpm` can refuse to run outside the repo
(`ERR_PNPM_BAD_PM_VERSION`) because the repo pins its pnpm version.

### Claude Desktop and other MCP clients

Add a server entry to the client's MCP config. For Claude Desktop that is
`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "jobflow": {
      "command": "node",
      "args": ["/path/to/jobflow/apps/cli/bin/jobflow.mjs", "mcp"],
      "env": { "JOBFLOW_DATA_DIR": "/home/you/.jobflow" }
    }
  }
}
```

Use absolute paths, because clients often start servers from `/`. The global flags work too:
`"args": [".../jobflow.mjs", "--data-dir", "/path", "mcp"]`, and `--store memory` gives you a
throwaway session. Your model key is read from the usual places: `jobflow config set llm.*`,
the repo's `.env`, or the data directory's `.env`. It is never returned by any tool.

### Options

| | |
|---|---|
| `--idle <seconds>` | Release the local database after this many idle seconds (default 20). |
| `--data-dir`, `--store`, `DATABASE_URL` | The same as for every `jobflow` command. |

## The single-writer database

Locally, JobFlow stores data in PGlite, which allows **one writer at a time**. An MCP client
keeps its server process running for as long as the chat is open, so `jobflow mcp` does
**not** hold the database for its whole lifetime:

- the database is opened on the first tool call, calls run one at a time, and it is released
  after 20 s idle. While the agent sits idle you can run `jobflow sync`, `jobflow feed` and so on
  as normal;
- if another process holds the data, typically `jobflow serve` (the web app), the tool
  returns a plain-language error instead of crashing: stop the web app, or wait for the other
  command to finish, then ask again;
- to run the web app and an agent **at the same time**, use Postgres. Set `DATABASE_URL` for
  both (see [self-hosting](self-hosting.md)). Postgres handles concurrent use.

`sync_sources` holds the database for its whole run, a minute or two. Other JobFlow tools wait
for it to finish.

## Reference

### Tools

Every tool returns structured content (with an output schema) plus a short text summary.
Errors come back as tool errors with a hint, never as a crash.

| Tool | What it does | Annotations |
|---|---|---|
| `jobflow_status` | Setup progress (profile? first sync? saved searches? tracked applications? model?) and the one next step. Call it first. | read-only |
| `search_jobs` | Searches live job sources (public ATS boards and feeds, Tier 1–2 only) and scores each result against your profile. `query` accepts the CLI's flag syntax (`"backend engineer" --remote --posted 7d --min-salary "40L INR"`), or use the structured fields (`keywords`, `titles`, `remote`, `locations`, `seniority`, `minSalary`, `postedWithinDays`, `mustSkills`, `presets`, `sources`, `limit`, `ingest`). Returns hidden counts per reason and how many results were hard-excluded. Results not yet in your feed are *transient*: `get_job` can read them, and acting on one saves it. | network |
| `list_jobs` | Your ranked feed: `limit`, `minScore`, `presets` (tags), `savedSearch` (as a view, with hidden counts) and `includeApplied`. Before onboarding it is an unscored browse feed. | read-only |
| `get_job` | One role in full, by id or unique prefix: the description (truncated, and flagged when it is), must-haves, the fit breakdown and notes, red flags, pay (stated vs estimate), freshness, tracker status, drafts, and the apply checklist with a fix for each gap. | read-only |
| `list_saved_searches` | Your saved searches. | read-only |
| `save_search` | Saves a search, or replaces one by `name`, using the same `query` syntax. It then runs on every sync and becomes a feed view. | writes |
| `run_saved_search` | Fetches a saved search's sources into your corpus now, then re-ranks. | writes, network |
| `track_application` | Starts tracking a role or updates it: `status` (saved, drafting, ready, applied, screening, interviewing, offer, rejected, withdrawn, ghosted), `note`, `nextAction` + `due` (YYYY-MM-DD). Only set "applied" when you've sent the application yourself. | writes |
| `list_applications` | Everything you're tracking, with due follow-ups first. | read-only |
| `prepare_application` | The apply plan as a **dry run**: the form URL, which of your stored values would go into which field, the résumé file it would attach, saved answers, and what's missing with the fix. Also returns the command **you** run to pre-fill: `jobflow apply <id> --fill`. Nothing is opened, filled or sent. | writes only when it saves a search result |
| `draft_document` | JobFlow's own grounded generators with your configured model. `kind`: `resume` (3 bullet variants + ATS keyword coverage), `resume_md`, `resume_latex`, `cover_letter`, `why_here`, `interesting_problem`, `about_blurb`, `answer` (+ `question`). Without a model, résumés come back as labelled `builtin` templates, and prose kinds return an error saying a model is needed. | writes, model API |
| `sync_sources` | Discovers + polls your discovery plan, expires what's gone, and re-ranks. It is bounded like `jobflow sync`; `full: true` runs the slow sweep. Sends progress notifications. | writes, network |

### Prompts

| Prompt | Arguments | What it gives the agent |
|---|---|---|
| `tailor_application` | `jobId`, `kind` (default `resume_md`), `question` | For when the agent writes **with its own model**: JobFlow's `HONEST_VOICE` rules word for word, your candidate material (base résumé, skills, contact, about), your Evidence Bank, the role's description, must-haves and the scorer's fit notes. The task is to rephrase, reorder and trim your material (never extend it), then list the gaps and the source of each line. |
| `triage_jobs` | `count` (default 10), `savedSearch`, `preset` | Your top jobs with their flags, and instructions to explain each fit honestly, recommend which to apply to and why, and stay within what the cards say. |

### Resources

| URI | What it is |
|---|---|
| `jobflow://profile` | Your profile and Evidence Bank as JSON. It is **sensitive** (contact details, résumé text, salary floor) and its description says so. |
| `jobflow://job/{id}` | One posting, with the same content as `get_job`. The list shows your top 20. |

## Example conversations

**"Find remote backend roles I'd actually get, and explain the gaps."**
The agent calls `search_jobs` with `{"query": "backend engineer --remote --posted 14d"}` and
gets scored results with flags. Some are not in your feed yet. It reads the top few with
`get_job` and explains each one from the card. For example: "Java is a direct match. It asks
for 5+ years and you have 3, so that's a stretch. Pay is JobFlow's estimate, not stated." It
also tells you what the query hid.

**"Tailor my résumé for the Acme Pay role."**
With a model configured, the agent calls `draft_document` with `{"id": "…", "kind":
"resume_md"}` and shows you the draft. Without one, it gets the labelled `builtin` template.
It can then write its own version through the `tailor_application` prompt, under the same
grounding rules, and must list any gaps instead of inventing experience.

**"Track it and remind me to follow up in a week."**
The agent calls `track_application` with `{"id": "…", "nextAction": "follow up", "due":
"2026-12-01"}`. Next time, `jobflow_status` or `list_applications` shows the follow-up as due.
Once you've sent the application, tell the agent and it sets `status: "applied"`.

**"Is it ready to apply?"**
`prepare_application` shows what would be filled and what's missing, such as a PDF résumé.
When you're ready, run `jobflow apply <id> --fill`. It pre-fills the form in a local browser
and stops at the review screen, and you send it yourself.

## Safety

- **JobFlow never submits.** No tool clicks, fills or sends a form. `prepare_application` is a
  dry run, and you run the form-filler yourself (`jobflow apply <id> --fill`), which stops at the
  review screen. A test lists every tool and fails if any name, description or schema
  mentions submitting outside "never submits" wording.
- **Writing is grounded.** `draft_document` uses JobFlow's generators (`HONEST_VOICE`, your
  material, nothing invented). The `tailor_application` prompt gives an agent writing with its
  own model the same rules. Review every line before you use it.
- **Your data stays local.** The server reads your local store and talks to job boards (and to
  your model provider, if you set one). Your profile and drafts go to whichever model **your
  MCP client** uses, because that is how the agent reads them. Treat `jobflow://profile` as
  personal data. LLM keys and tokens never appear in any output.
- **Public sources only.** Search and sync reach Tier 1–2 sources only. Logged-in sites
  (LinkedIn, Naukri, Glassdoor) stay with the optional [local agent](local-agent.md).
- **One person.** The server runs as the local default tenant, like the CLI, and never returns
  another tenant's data.

## Roadmap

- **Hosted MCP over HTTP**: the streamable HTTP transport on the multi-user web app, with
  per-user API tokens (like the extension's) and the caller's tenant on every call.
- Tool-level elicitation (for example, confirming before `sync_sources` runs a full sweep), and
  resource subscriptions for "new matches since …".

See also: [CLI reference](../cli.md#jobflow-mcp) · [Applying](apply.md) ·
[LLM providers](llm-providers.md) · [Troubleshooting](troubleshooting.md)
