# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
[security advisories](https://github.com/jagritvats/autohire/security/advisories/new) —
never in a public issue, discussion or pull request. Include steps to reproduce and the
affected version/commit. We aim to acknowledge reports within 7 days.

Only the latest `main` is supported.

## What counts as a security bug

- Any way to make the form-filler **submit** an application (the review gate is a hard
  invariant), or to flip `JOBFLOW_AUTOSUBMIT`.
- Any path that lets the cloud worker or web server run a **Tier-3** source or hold a
  user's LinkedIn / Naukri / Glassdoor session.
- **Cross-tenant access** in multi-user mode (`JOBFLOW_AUTH=password`): reading or writing
  another user's profile, evidence, applications, drafts, searches, sources, tokens or keys.
- Leaking secrets: LLM API keys, session cookies, API tokens, `JOBFLOW_SECRET_KEY`.
- Server-side request forgery through user-supplied URLs (custom feeds, careers URLs,
  LLM base URLs), or cross-site request forgery against the local API.

## Deployment notes

- The default `JOBFLOW_AUTH=none` mode is a **single-user localhost tool**: it only answers
  loopback requests from the same origin. Do not expose it to a network. To host JobFlow for
  several people, use `JOBFLOW_AUTH=password`, set `JOBFLOW_SECRET_KEY`, serve it over HTTPS
  and keep Postgres off the public internet.
- Docker Compose binds the web app and Postgres to `127.0.0.1` by default; change that only
  behind a reverse proxy with TLS.
- Treat the data directory (`~/.jobflow` or `JOBFLOW_DATA_DIR`), uploaded résumés and the
  local agent's browser profile as sensitive.
