# Self-hosting for several people (optional)

Most people should run JobFlow locally for themselves — that's the default and needs none of
this. This page is for running **one shared instance** (for a team, a bootcamp cohort, or a
hosted service).

## What changes in multi-user mode

`JOBFLOW_AUTH=password` turns on accounts:

- **Accounts** — email + password (scrypt). The first account becomes the admin and keeps any
  existing single-user data; more sign-ups are allowed only with `JOBFLOW_SIGNUP=open`.
- **Per-user data** — each user has their own profile, Evidence Bank, LLM key, saved searches,
  discovery sources, applications, drafts and matches. Postings and the company registry are a
  shared public corpus.
- **Sessions** — httpOnly, SameSite=Lax cookies; state-changing requests must come from the
  app's own origin.
- **API tokens** — Settings → API tokens mints scoped, revocable tokens (`cli`, `extension`,
  `agent`), shown once and stored as hashes. (A token is only needed for the browser
  extension, the local agent, or a CLI talking to the server.)
- **Admin-only** — instance-wide jobs (discover, full polls, purges) and registry edits.
- **LLM keys** — users bring their own; the operator's env key is used for them only with
  `JOBFLOW_OPERATOR_LLM=shared`.
- **Local agent** — each user runs their own agent on their own machine with
  `JOBFLOW_AGENT_TOKEN` (scope `agent`); it only ever claims that user's jobs. (Today the agent
  still needs database access; an HTTP-only agent for hosted instances is on the roadmap.)

## Checklist

1. Postgres with TLS (`DATABASE_URL=…?sslmode=require`); run `pnpm db:migrate`.
2. `JOBFLOW_AUTH=password`, `JOBFLOW_SECRET_KEY=$(openssl rand -base64 32)`,
   `JOBFLOW_PUBLIC_URL=https://jobs.example.com`.
3. Serve over HTTPS behind a reverse proxy; set `JOBFLOW_TRUST_PROXY=1` only if the proxy sets
   `X-Forwarded-Host`/`-For`.
4. Run the worker (`pnpm worker`) so polling happens off the request path — in multi-user mode
   the web app never polls inside a request.
5. Back up the database privately: it holds people's résumés and contact details. Publish a
   privacy notice.

Docker Compose works for this too. Set the variables above in `.env`, and change the address
the web port binds to with `JOBFLOW_WEB_BIND=0.0.0.0` (only behind your TLS proxy). It's an
address, not `host:port`: the published port stays 3000. `pnpm docker:logs` follows the web
and worker logs. See [Troubleshooting](troubleshooting.md#port-3000-is-already-in-use) for port
clashes.

## Licence obligations

JobFlow is AGPL-3.0-only. Running it unmodified for others is fine — the footer's "source"
link points at the upstream repository. If you run a **modified** version as a service, §13
of the licence requires you to offer its users the corresponding source of your version: set
`JOBFLOW_SOURCE_URL` to where your modified source is published.

See [SECURITY.md](../../SECURITY.md) for what counts as a vulnerability and how to report it.
