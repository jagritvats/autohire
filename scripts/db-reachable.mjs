#!/usr/bin/env node
// Is a database configured, and is it accepting connections? Used by scripts/dev.* so
// local dev never assumes a running Postgres.
//   exit 0 → DATABASE_URL set and its host:port accepts TCP connections
//   exit 1 → DATABASE_URL unset/blank (in-memory / PGlite default applies)
//   exit 2 → set but unreachable (or unparsable)
// Reads the process env first, then the repo-root .env (simple KEY=value lines).
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fromDotEnv(key) {
  let text = "";
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return undefined;
  }
  let value;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ""); // unquoted value: strip an inline comment
    value = v.trim(); // last assignment wins, like most dotenv parsers
  }
  return value;
}

const url = (process.env.DATABASE_URL ?? fromDotEnv("DATABASE_URL") ?? "").trim();
if (!url) {
  console.log("DATABASE_URL is not set");
  process.exit(1);
}

let host;
let port;
try {
  const u = new URL(url);
  host = u.hostname || "localhost";
  port = Number(u.port || 5432);
} catch {
  console.log("DATABASE_URL is set but is not a valid URL");
  process.exit(2);
}

const sock = connect({ host, port });
const done = (code, msg) => {
  console.log(msg);
  sock.destroy();
  process.exit(code);
};
sock.setTimeout(2500, () => done(2, `${host}:${port} did not answer`));
sock.once("connect", () => done(0, `${host}:${port} is reachable`));
sock.once("error", (e) => done(2, `${host}:${port} is unreachable (${e.code ?? e.message})`));
