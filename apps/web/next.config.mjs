import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the monorepo-root .env (single source of truth) into process.env at config
// time, so server code (PgRepository, LLM keys) sees DATABASE_URL without a
// duplicated apps/web/.env. Does not override already-set vars.
(function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const p = join(dir, ".env");
      if (existsSync(p)) {
        for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          const eq = line.indexOf("=");
          if (eq <= 0) continue;
          const k = line.slice(0, eq).trim();
          let v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
          if (process.env[k] === undefined) process.env[k] = v;
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

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
