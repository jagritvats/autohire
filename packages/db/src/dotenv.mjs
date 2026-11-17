// Plain-JS `.env` loader shared by the TS packages (via env.ts) and apps/web/next.config.mjs
// (which can't import TypeScript) — one parser, so `pnpm web` and the worker/CLI read the
// same file the same way. Zero dependencies.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** index of the closing quote in `s` (honouring backslash escapes inside double quotes), or -1. */
function closingQuote(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

function unescapeDouble(s) {
  return s.replace(/\\([nrt"\\])/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

/**
 * Parse dotenv text → { KEY: value }. Handles `export ` prefixes, single quotes (literal),
 * double quotes (\n \r \t \" \\ escapes; may span lines), unquoted values with inline
 * ` # comments` stripped (a `#` not preceded by whitespace stays: `pa#ss`), empty values,
 * CRLF and a BOM. Malformed lines are skipped; a later duplicate key wins.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const out = {};
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimStart();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    const rest = line.slice(eq + 1).trimStart();
    const q = rest[0];

    if (q === '"' || q === "'") {
      let body = rest.slice(1);
      let close = closingQuote(body, q);
      let j = i;
      while (close < 0 && j + 1 < lines.length) {
        body += "\n" + lines[++j];
        close = closingQuote(body, q);
      }
      if (close >= 0) {
        const raw = body.slice(0, close);
        out[key] = q === '"' ? unescapeDouble(raw) : raw;
        i = j;
        continue;
      }
      // unterminated quote: fall through and treat this line as an unquoted value
    }

    const hash = rest.search(/(^|\s)#/);
    out[key] = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
  }
  return out;
}

/**
 * Apply a dotenv file to `env` WITHOUT overriding variables that are already set (the
 * shell / process manager wins). Returns true if the file existed.
 * @param {string} path
 * @param {Record<string, string | undefined>} [env]
 */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return false;
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
    if (env[k] === undefined) env[k] = v;
  }
  return true;
}

/** nearest ancestor holding pnpm-workspace.yaml (the monorepo root), or null. */
export function findWorkspaceRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the monorepo-root `.env`, then `$JOBFLOW_DATA_DIR/.env` (an installed CLI's
 * config) — never overriding already-set vars, so earlier sources win. Returns the
 * files that were loaded.
 * @param {string} [startDir]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function loadRootEnv(startDir = process.cwd(), env = process.env) {
  const loaded = [];
  const root = findWorkspaceRoot(startDir);
  if (root && loadEnvFile(join(root, ".env"), env)) loaded.push(join(root, ".env"));
  const dataDir = env.JOBFLOW_DATA_DIR && env.JOBFLOW_DATA_DIR.trim();
  if (dataDir) {
    const d = dataDir === "~" ? homedir() : dataDir.startsWith("~/") ? join(homedir(), dataDir.slice(2)) : dataDir;
    const p = join(resolve(d), ".env");
    if (loadEnvFile(p, env)) loaded.push(p);
  }
  return loaded;
}
