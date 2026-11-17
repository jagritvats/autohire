# JobFlow — multi-stage image for the cloud planes (web + worker) and the migrator.
# Workspace packages are consumed as TS source (transpilePackages + tsx), so there is
# no per-package build step — `base` installs once and the targets just set a CMD.
# The local AGENT (Tier-3 + form-fill) is NOT built here — it stays on your machine.
# Everything runs as the unprivileged `node` user (uid 1000) from the official image.

# ── base: install the whole workspace once ──────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV CI=1 PNPM_HOME=/pnpm COREPACK_HOME=/corepack PATH="/pnpm:$PATH" JOBFLOW_DATA_DIR=/data
# corepack shims go in /usr/local/bin (root); every writable dir is handed to `node`.
# /data is created here so a fresh named volume mounted on it inherits node's ownership.
RUN corepack enable \
 && mkdir -p /app /pnpm /corepack /data \
 && chown node:node /app /pnpm /corepack /data
USER node
WORKDIR /app
# host node_modules / .next / .env are excluded via .dockerignore
COPY --chown=node:node . .
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
USER root
RUN if [ "$INSTALL_LATEX" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      && rm -rf /var/lib/apt/lists/*; \
    fi
USER node
RUN pnpm --filter @jobflow/web build
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["pnpm", "--filter", "@jobflow/web", "start"]
