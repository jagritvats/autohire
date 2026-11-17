import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// the same zero-dependency parser the worker/CLI use (packages/db/src/env.ts re-exports it)
import { loadRootEnv } from "../../packages/db/src/dotenv.mjs";

// Load the monorepo-root .env (single source of truth), then $JOBFLOW_DATA_DIR/.env, into
// process.env at config time, so server code (PgRepository, LLM keys) sees DATABASE_URL
// without a duplicated apps/web/.env. Does not override already-set vars; strips inline
// `# comments` from unquoted values.
loadRootEnv(dirname(fileURLToPath(import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
  experimental: {
    externalDir: true,
    // pdf-parse is CommonJS with a require-time test-file shim — keep it external to
    // the server bundle so Next doesn't try to trace/bundle that fixture (resume upload).
    serverComponentsExternalPackages: ["pdf-parse"],
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
