import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// the same zero-dependency parser the worker/CLI use (packages/db/src/env.ts re-exports it)
import { loadRootEnv } from "../../packages/db/src/dotenv.mjs";

// Load the monorepo-root .env (single source of truth), then $JOBFLOW_DATA_DIR/.env, into
// process.env at config time, so server code (PgRepository, LLM keys) sees DATABASE_URL
// without a duplicated apps/web/.env. Does not override already-set vars; strips inline
// `# comments` from unquoted values.
const here = dirname(fileURLToPath(import.meta.url));
loadRootEnv(here);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // the monorepo root: file tracing then follows the workspace packages, and Next doesn't
  // guess the root from whichever lockfile it finds first (e.g. in a nested checkout)
  outputFileTracingRoot: resolve(here, "../.."),
  // workspace packages are TS source — let Next transpile them
  transpilePackages: [
    "@jobflow/core",
    "@jobflow/adapters",
    "@jobflow/db",
    "@jobflow/llm",
    "@jobflow/pipeline",
    "@jobflow/autofill",
    "@jobflow/service",
    "@jobflow/resume-io",
  ],
  // pdf-parse is CommonJS with a require-time test-file shim — keep it external to
  // the server bundle so Next doesn't try to trace/bundle that fixture (resume upload).
  serverExternalPackages: ["pdf-parse"],
  // the app never uses next/image; turning the optimizer off removes the /_next/image
  // endpoint — the surface of Next's image-optimizer advisories — entirely
  images: { unoptimized: true },
  experimental: {
    externalDir: true,
  },
  webpack: (config) => {
    // workspace packages import with ESM ".js" specifiers that point at ".ts"
    // source — let webpack resolve .js → .ts/.tsx (then fall back to real .js).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
