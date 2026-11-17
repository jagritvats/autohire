import { styleText } from "node:util";

/**
 * Terminal output. Data goes to stdout (a table, cards, or `--json`); progress, prompts
 * and hints go to stderr so `jobflow … --json | jq` stays clean. Colour only on a TTY,
 * never with NO_COLOR / --no-color (FORCE_COLOR forces it on).
 */

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  stdin: NodeJS.ReadableStream;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function processIO(): CliIO {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    stdin: process.stdin,
    stdoutIsTTY: !!process.stdout.isTTY,
    stderrIsTTY: !!process.stderr.isTTY,
    stdinIsTTY: !!process.stdin.isTTY,
    env: process.env,
  };
}

type Fmt = Parameters<typeof styleText>[0];

export class Out {
  readonly color: boolean;
  readonly json: boolean;

  constructor(
    readonly io: CliIO,
    opts: { json?: boolean; color?: boolean },
  ) {
    this.json = !!opts.json;
    const env = io.env;
    const forced = env.FORCE_COLOR != null && env.FORCE_COLOR !== "0";
    this.color = opts.color !== false && !("NO_COLOR" in env && env.NO_COLOR !== "") && (forced || io.stdoutIsTTY) && env.TERM !== "dumb";
  }

  // ── styling ──
  style(fmt: Fmt, s: string): string {
    if (!this.color) return s;
    // validateStream:false — we've already decided (tests capture output without a TTY)
    return (styleText as (f: Fmt, t: string, o?: { validateStream?: boolean }) => string)(fmt, s, { validateStream: false });
  }
  bold = (s: string) => this.style("bold", s);
  dim = (s: string) => this.style("dim", s);
  green = (s: string) => this.style("green", s);
  yellow = (s: string) => this.style("yellow", s);
  red = (s: string) => this.style("red", s);
  cyan = (s: string) => this.style("cyan", s);

  // ── streams ──
  /** a line of DATA (suppressed in --json mode: the JSON document is the data) */
  line(s = ""): void {
    if (!this.json) this.io.out(s + "\n");
  }
  /** a status/hint line on stderr (also suppressed in --json mode) */
  note(s: string): void {
    if (!this.json) this.io.err(s + "\n");
  }
  /** a warning on stderr — shown even with --json */
  warn(s: string): void {
    this.io.err(`${this.yellow("warning:")} ${s}\n`);
  }
  ok(s: string): void {
    this.line(`${this.green("✓")} ${s}`);
  }
  hint(s: string): void {
    this.note(this.dim(s));
  }
  /** print `data` as JSON when --json, otherwise run the human renderer */
  emit<T>(data: T, human: (d: T) => void): void {
    if (this.json) this.io.out(JSON.stringify(data, jsonReplacer, 2) + "\n");
    else human(data);
  }

  // ── tables ──
  table(headers: string[], rows: string[][], opts: { maxWidth?: number[] } = {}): void {
    const widths = headers.map((h, i) =>
      Math.min(opts.maxWidth?.[i] ?? 60, Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? "")))),
    );
    const fmtRow = (r: string[]) =>
      r
        .map((c, i) => padVisible(truncate(c ?? "", widths[i]!), widths[i]!))
        .join("  ")
        .trimEnd();
    this.line(this.dim(fmtRow(headers)));
    for (const r of rows) this.line(fmtRow(r));
  }

  // ── progress (stderr) ──
  spinner(label: string): Spinner {
    if (this.json) return { update() {}, stop() {} };
    if (!this.io.stderrIsTTY) {
      this.io.err(`${label}…\n`);
      return { update() {}, stop: (final?: string) => void (final ? this.io.err(final + "\n") : undefined) };
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    let text = label;
    const draw = () => this.io.err(`\r\x1b[2K${this.cyan(frames[i++ % frames.length]!)} ${text}`);
    draw();
    const t = setInterval(draw, 90);
    t.unref?.();
    return {
      update: (s: string) => {
        text = s;
      },
      stop: (final?: string) => {
        clearInterval(t);
        this.io.err("\r\x1b[2K" + (final ? final + "\n" : ""));
      },
    };
  }
}

export interface Spinner {
  update(s: string): void;
  stop(final?: string): void;
}

/** Dates as ISO, Sets as arrays — JSON output stays machine-readable. */
function jsonReplacer(_k: string, v: unknown): unknown {
  if (v instanceof Set) return [...v];
  return v;
}

const ANSI = /\x1b\[[0-9;]*m/g;
export function visibleLen(s: string): number {
  return [...s.replace(ANSI, "")].length;
}
function padVisible(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visibleLen(s)));
}
export function truncate(s: string, n: number): string {
  if (visibleLen(s) <= n) return s;
  const plain = [...s.replace(ANSI, "")];
  return plain.slice(0, Math.max(0, n - 1)).join("") + "…";
}

/** "3d ago" / "today" */
export function ago(days: number): string {
  if (days <= 0) return "today";
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** mask a secret: never echo more than its last 4 characters */
export function mask(secret: string): string {
  const s = secret.trim();
  if (!s) return "(not set)";
  return s.length <= 8 ? "••••" : `••••${s.slice(-4)}`;
}
