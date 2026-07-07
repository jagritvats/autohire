# JobFlow — multi-stage image for the cloud planes (web + worker) and the migrator.
# Workspace packages are consumed as TS source (transpilePackages + tsx), so there is
# no per-package build step — `base` installs once and the targets just set a CMD.
# The local AGENT (Tier-3 + form-fill) is NOT built here — it stays on your machine.

# ── base: install the whole workspace once ──────────────────────────────────
FROM node:20-bookworm-slim AS base
ENV CI=1 PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app
# host node_modules / .next / .env are excluded via .dockerignore
COPY . .
RUN pnpm install --frozen-lockfile

# ── migrate: forward-only, idempotent migrator (one-shot) ───────────────────
FROM base AS migrate
CMD ["pnpm", "--filter", "@jobflow/db", "migrate"]

# ── worker: cloud job runner (Tier 1-2: poll / discover / rank / enrich) ────
FROM base AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@jobflow/worker", "runner"]

# ── web: the Next.js control plane ──────────────────────────────────────────
FROM base AS web
# LaTeX résumé → PDF compile (/api/resume/pdf). Set INSTALL_LATEX=0 to skip the
# ~hundreds-of-MB TeX install; the .tex download fallback works without it.
ARG INSTALL_LATEX=1
RUN if [ "$INSTALL_LATEX" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      && rm -rf /var/lib/apt/lists/*; \
    fi
RUN pnpm --filter @jobflow/web build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@jobflow/web", "start"]
