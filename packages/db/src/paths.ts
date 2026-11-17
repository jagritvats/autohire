import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

/**
 * The per-user data dir for zero-infra durable mode (PGlite database, uploaded files,
 * an optional `.env`): `$JOBFLOW_DATA_DIR`, else `~/.jobflow`. Never inside the repo
 * tree, so personal files can't be committed by accident.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.JOBFLOW_DATA_DIR?.trim();
  return resolve(d ? expandHome(d) : join(homedir(), ".jobflow"));
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** mkdir -p with owner-only permissions (the dir holds résumés and an LLM key). */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── single-writer lock ──

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export interface DataDirLock {
  path: string;
  release(): void;
}

const held = new Map<string, string>(); // abs dir → lock file path (this process)
let exitHookInstalled = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    return typeof v.pid === "number" ? { pid: v.pid, host: String(v.host ?? ""), startedAt: String(v.startedAt ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * PGlite is single-writer: two processes opening the same data dir corrupt it. Take an
 * exclusive lockfile (`<dir>/.lock`, pid + host); a lock left by a dead pid on this host
 * is stale and taken over. Released on `release()` or process exit.
 */
export function acquireDataDirLock(dir: string): DataDirLock {
  const abs = resolve(dir);
  if (held.has(abs)) throw new Error(`JobFlow data dir ${abs} is already open in this process`);
  ensurePrivateDir(abs);
  const path = join(abs, ".lock");
  const me: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };

  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(me), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e;
      const other = readLock(path);
      if (other && other.host && other.host !== me.host) {
        throw new Error(
          `JobFlow data dir ${abs} is locked by pid ${other.pid} on host ${other.host}. ` +
            `If that process is gone, delete ${path}.`,
        );
      }
      if (other && other.pid !== process.pid && pidAlive(other.pid)) {
        throw new Error(
          `JobFlow data dir ${abs} is in use by another process (pid ${other.pid}, since ${other.startedAt}). ` +
            `The local database is single-writer — stop that process (e.g. a running \`jobflow\` or web server) ` +
            `or point this one at another dir with JOBFLOW_DATA_DIR.`,
        );
      }
      rmSync(path, { force: true }); // stale (dead pid / unreadable) → take it over
    }
  }

  held.set(abs, path);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const p of held.values()) releaseFile(p);
    });
  }
  return {
    path,
    release() {
      if (held.get(abs) !== path) return;
      held.delete(abs);
      releaseFile(path);
    },
  };
}

function releaseFile(path: string): void {
  const cur = readLock(path);
  if (cur && cur.pid !== process.pid) return; // someone else's now — leave it
  rmSync(path, { force: true });
}
