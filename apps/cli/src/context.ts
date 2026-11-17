import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Command } from "commander";
import { createFileStore, createRepository, ensurePrivateDir, loadRootEnv, type FileStore, type Repository, type StoreKind } from "@jobflow/db";
import { DEFAULT_TENANT, blankProfile } from "@jobflow/pipeline";
import { defaultConfig } from "@jobflow/service";
import type { Posting } from "@jobflow/core";
import { CliError, EXIT } from "./errors.js";
import { Out, type CliIO } from "./output.js";

/**
 * Per-invocation context: global flags, the data dir, and a LAZILY opened repository —
 * commands that don't touch the database (help, serve, demo, parts of doctor) never take
 * the PGlite single-writer lock. The CLI is the default tenant: one person, one machine.
 */

export interface GlobalOpts {
  json?: boolean;
  dataDir?: string;
  store?: string;
  color?: boolean;
}

export interface CtxOptions {
  io: CliIO;
  /** tests: share one repository across invocations (never closed by the CLI) */
  repo?: Repository;
}

/** What the CLI remembers between runs (`<dataDir>/cli.json`) — the last listing for #N refs. */
export interface CliState {
  listing?: { kind: "feed" | "search" | "track"; at: string; ids: string[] };
  /** search results not (yet) in your corpus, kept so `apply 3` can save the one you pick */
  transient?: Record<string, Posting>;
}

export interface ServerInfo {
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

export class Ctx {
  readonly tenantId = DEFAULT_TENANT;
  readonly io: CliIO;
  /** a command that succeeded but wants a non-zero exit (e.g. doctor found a failure) */
  exitCode: number | undefined;
  private program: Command | null = null;
  private repoP: Promise<Repository> | null = null;
  private owned = false;
  private injected: Repository | undefined;
  private outCache: Out | null = null;
  private lines: LineReader | null = null;
  private envLoaded = false;

  constructor(opts: CtxOptions) {
    this.io = opts.io;
    this.injected = opts.repo;
  }

  attach(program: Command): void {
    this.program = program;
  }

  get opts(): GlobalOpts {
    return (this.program?.opts() ?? {}) as GlobalOpts;
  }

  get out(): Out {
    this.outCache ??= new Out(this.io, { json: this.opts.json, color: this.opts.color });
    return this.outCache;
  }

  /** where the user ran the command (pnpm scripts run from the repo root; INIT_CWD is the shell's cwd) */
  get cwd(): string {
    return this.io.env.INIT_CWD || process.cwd();
  }

  /** a user-supplied path, relative to where they ran the command, `~` expanded */
  userPath(p: string): string {
    const e = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    return resolve(this.cwd, e);
  }

  get dataDir(): string {
    const flag = this.opts.dataDir?.trim();
    if (flag) return this.userPath(flag);
    const env = this.io.env.JOBFLOW_DATA_DIR?.trim();
    if (env) return this.userPath(env);
    return join(homedir(), ".jobflow");
  }

  get storeKind(): StoreKind {
    const s = this.opts.store?.trim().toLowerCase();
    if (s) {
      if (s === "pglite" || s === "memory" || s === "postgres") return s;
      throw new CliError(`--store must be pglite or memory (got "${s}")`, EXIT.usage);
    }
    if (this.io.env.DATABASE_URL) return "postgres";
    const env = this.io.env.JOBFLOW_STORE?.trim().toLowerCase();
    if (env === "memory" || env === "pglite" || env === "postgres") return env;
    return "pglite";
  }

  /**
   * Point the shared packages at this data dir (they read JOBFLOW_DATA_DIR: file store,
   * tailored PDFs, `.env`) and load the repo-root + data-dir `.env` once.
   */
  loadEnv(): void {
    if (this.envLoaded) return;
    this.envLoaded = true;
    process.env.JOBFLOW_DATA_DIR = this.dataDir;
    loadRootEnv(this.cwd);
  }

  /** the repository, opened (and migrated) on first use; the default tenant bootstrapped */
  repo(): Promise<Repository> {
    this.repoP ??= this.openRepo();
    return this.repoP;
  }

  private async openRepo(): Promise<Repository> {
    this.loadEnv();
    let repo: Repository;
    if (this.injected) repo = this.injected;
    else {
      const store = this.storeKind;
      if (store === "pglite") ensurePrivateDir(this.dataDir);
      try {
        repo = await createRepository({ store, dataDir: this.dataDir });
      } catch (e) {
        throw this.friendlyOpenError(e as Error);
      }
      this.owned = true;
    }
    await bootstrap(repo, this.tenantId);
    return repo;
  }

  private friendlyOpenError(e: Error): Error {
    const msg = e.message ?? String(e);
    if (/in use by another process|is locked by pid|already open in this process/.test(msg)) {
      const server = this.serverInfo();
      const pid = msg.match(/pid (\d+)/)?.[1];
      return new CliError(
        server
          ? `Your JobFlow data is open in \`jobflow serve\` (${server.url}, pid ${server.pid}).`
          : `Your JobFlow data (${this.dataDir}) is open in another process${pid ? ` (pid ${pid})` : ""}.`,
        EXIT.error,
        "The local database is single-writer. Use the web UI while it runs, or stop it (Ctrl-C) and re-run this command." +
          (server ? "" : " If no jobflow process is running, delete the stale .lock file in the data dir."),
      );
    }
    return e;
  }

  serverInfo(): ServerInfo | null {
    try {
      const s = JSON.parse(readFileSync(join(this.dataDir, "server.json"), "utf8")) as ServerInfo;
      return typeof s.pid === "number" ? s : null;
    } catch {
      return null;
    }
  }

  files(): FileStore {
    this.loadEnv();
    return createFileStore(join(this.dataDir, "files"));
  }

  // ── state (cli.json) ──
  private statePath(): string {
    return join(this.dataDir, "cli.json");
  }
  readState(): CliState {
    try {
      return JSON.parse(readFileSync(this.statePath(), "utf8")) as CliState;
    } catch {
      return {};
    }
  }
  writeState(patch: Partial<CliState>): void {
    try {
      ensurePrivateDir(this.dataDir);
      const next = { ...this.readState(), ...patch };
      writeFileSync(this.statePath(), JSON.stringify(next), { mode: 0o600 });
    } catch {
      /* refs are a convenience — never fail a command over them */
    }
  }
  /** remember a listing so `#N` / `N` refer to its rows */
  rememberListing(kind: NonNullable<CliState["listing"]>["kind"], ids: string[], transient?: Record<string, Posting>): void {
    const patch: Partial<CliState> = { listing: { kind, at: new Date().toISOString(), ids } };
    if (transient) patch.transient = transient;
    this.writeState(patch);
  }

  // ── prompts (interactive commands) ──
  private reader(): LineReader {
    this.lines ??= new LineReader(this.io);
    return this.lines;
  }
  /** ask on stderr, read a line from stdin; Enter (or end of input) keeps `def` */
  async ask(question: string, def = ""): Promise<string> {
    const shown = def ? `${question} ${this.out.dim(`[${def}]`)} ` : `${question} `;
    const a = await this.reader().question(shown);
    return a == null || a.trim() === "" ? def : a.trim();
  }
  /** one raw line from stdin (null at end of input) */
  readLine(prompt = ""): Promise<string | null> {
    return this.reader().question(prompt);
  }
  async confirm(question: string, def = false): Promise<boolean> {
    const a = await this.ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`, "");
    if (!a) return def;
    return /^y(es)?$/i.test(a);
  }
  /** a hidden prompt (API keys): nothing is echoed */
  async secret(question: string): Promise<string> {
    return ((await this.reader().question(question, { hidden: true })) ?? "").trim();
  }
  /** all of stdin (for `--stdin` / `-`) */
  async readStdin(): Promise<string> {
    if (this.lines) return this.lines.rest();
    const chunks: Buffer[] = [];
    for await (const c of this.io.stdin as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
  }

  async close(): Promise<void> {
    this.lines?.close();
    if (this.repoP && this.owned) {
      const repo = await this.repoP.catch(() => null);
      const closable = repo as (Repository & { close?: () => Promise<void> }) | null;
      await closable?.close?.().catch(() => {});
    }
    this.repoP = null;
  }
}

/** Idempotent first-run bootstrap: the tenant, a BLANK profile, a default config. */
async function bootstrap(repo: Repository, tenantId: string): Promise<void> {
  if (!(await repo.getTenant(tenantId).catch(() => null))) await repo.createTenant({ id: tenantId, name: "default" }).catch(() => undefined);
  if (!(await repo.getProfile(tenantId))) await repo.saveProfile(blankProfile(tenantId));
  if (!(await repo.getConfig(tenantId))) await repo.saveConfig(defaultConfig(tenantId));
}

/**
 * Line-at-a-time stdin for prompts that works the same on a TTY and on a pipe (tests,
 * `yes | jobflow …`): end of input answers every remaining question with its default.
 */
class LineReader {
  private queue: string[] = [];
  private waiting: ((l: string | null) => void) | null = null;
  private ended = false;
  private rl: ReturnType<typeof createInterface>;
  private muted = false;
  private sink: Writable;

  constructor(private io: CliIO) {
    const self = this;
    this.sink = new Writable({
      write(chunk, _enc, cb) {
        if (!self.muted) io.err(String(chunk));
        cb();
      },
    });
    this.rl = createInterface({ input: io.stdin, output: this.sink, terminal: io.stdinIsTTY && io.stderrIsTTY });
    this.rl.on("line", (l) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(l);
      } else this.queue.push(l);
    });
    this.rl.on("close", () => {
      this.ended = true;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(null);
      }
    });
  }

  question(prompt: string, opts: { hidden?: boolean } = {}): Promise<string | null> {
    this.io.err(prompt);
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.ended) return Promise.resolve(null);
    this.muted = !!opts.hidden;
    return new Promise((res) => {
      this.waiting = (l) => {
        if (this.muted) this.io.err("\n");
        this.muted = false;
        res(l);
      };
    });
  }

  async rest(): Promise<string> {
    const lines = [...this.queue];
    this.queue = [];
    while (!this.ended) {
      const l = await new Promise<string | null>((res) => (this.waiting = res));
      if (l == null) break;
      lines.push(l);
    }
    return lines.join("\n");
  }

  close(): void {
    this.rl.close();
  }
}

export function existsFile(p: string): boolean {
  return existsSync(p);
}
