import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Load the monorepo-root `.env` into process.env (without overriding already-set
 * vars). Zero-dependency so node entrypoints (migrate/worker/cli) pick up
 * DATABASE_URL etc. regardless of cwd. Next.js loads its own .env, so the web app
 * doesn't call this. No-op if the file is absent (in-memory fallback still works).
 */
export function loadRootEnv(startDir = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 7; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) applyEnv(readFileSync(envPath, "utf8"));
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function applyEnv(text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
