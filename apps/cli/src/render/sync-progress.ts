import { SYNC_PHASE_LABEL, type SyncPhaseId, type SyncProgress } from "@jobflow/core";
import { etaWords, syncStatusLine } from "@jobflow/service";
import type { Out } from "../output.js";

/**
 * `jobflow sync` progress, from the one SyncProgress model, on stderr (stdout stays data):
 *  - a TTY: a live two-line display — spinner, phase, bar, boards n/N, ETA; then in flight;
 *  - not a TTY (CI, a pipe, a log file): plain lines — each phase as it starts and ends,
 *    and the board count every 10%;
 *  - `--json`: one JSON object per line ({"type":"sync.progress", …}) at each phase change
 *    and at most twice a second, so scripts can follow along while stdout keeps the
 *    single summary document.
 */
export interface SyncProgressView {
  update(s: SyncProgress): void;
  /** clear the live display (before the summary is printed) */
  stop(): void;
}

export function syncProgressView(out: Out): SyncProgressView {
  if (out.json) return jsonEvents(out);
  if (out.io.stderrIsTTY) return liveDisplay(out);
  return lineLog(out);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function bar(fraction: number, width = 20): string {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

/** the one-line status shared with the MCP progress notifications */
export const statusLine = syncStatusLine;
export { etaWords };

function secs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function boardFraction(s: SyncProgress): number {
  const b = s.boards;
  if (s.phase === "feeds" && s.feeds.total) return (s.feeds.done + s.feeds.failed) / s.feeds.total;
  return b.total ? (b.done + b.failed + b.skipped) / b.total : 0;
}

function liveDisplay(out: Out): SyncProgressView {
  let last: SyncProgress | null = null;
  let lines = 0;
  let i = 0;
  const width = () => Math.max(40, Math.min(120, (process.stderr.columns ?? 100) - 1));
  const clip = (t: string) => (t.length > width() ? `${t.slice(0, width() - 1)}…` : t);
  const draw = () => {
    if (!last) return;
    const s = last;
    const head = `${out.cyan(FRAMES[i++ % FRAMES.length]!)} ${bar(boardFraction(s))} ${clip(statusLine(s))}`;
    const flight = s.boards.inFlight.length ? out.dim(clip(`  fetching ${s.boards.inFlight.slice(0, 4).join(", ")}${s.boards.inFlight.length > 4 ? `, +${s.boards.inFlight.length - 4}` : ""}`)) : "";
    let frame = lines ? `\x1b[${lines}F` : "\r";
    frame += `\x1b[2K${head}\n\x1b[2K${flight}\n`;
    out.io.err(frame);
    lines = 2;
  };
  const timer = setInterval(draw, 120);
  timer.unref?.();
  return {
    update(s) {
      last = s;
    },
    stop() {
      clearInterval(timer);
      if (lines) out.io.err(`\x1b[${lines}F\x1b[2K\n\x1b[2K\x1b[1F`);
      lines = 0;
    },
  };
}

function lineLog(out: Out): SyncProgressView {
  const seen = new Map<SyncPhaseId, string>();
  let lastDecile = -1;
  let saidStopping = false;
  return {
    update(s) {
      for (const p of s.phases) {
        if (seen.get(p.id) === p.status || p.status === "pending") continue;
        seen.set(p.id, p.status);
        const label = SYNC_PHASE_LABEL[p.id];
        if (p.status === "active") {
          const extra =
            p.id === "boards" && s.boards.total ? ` (${s.boards.total} boards${s.boards.notDue ? `, ${s.boards.notDue} not due yet` : ""})` : p.id === "feeds" && s.feeds.total ? ` (${s.feeds.total})` : "";
          out.io.err(`→ ${label}${extra}\n`);
        } else if (p.status === "done") {
          const ms = p.startedAt != null && p.finishedAt != null ? p.finishedAt - p.startedAt : null;
          out.io.err(`✓ ${label}${ms != null && ms >= 1000 ? ` (${secs(ms)})` : ""}\n`);
        } else if (p.status === "skipped" && s.status === "running") {
          out.io.err(`- ${label}: skipped\n`);
        }
      }
      if (s.phase === "boards" && s.boards.total) {
        const decile = Math.floor(((s.boards.done + s.boards.failed) / s.boards.total) * 10);
        if (decile > lastDecile && decile > 0) {
          lastDecile = decile;
          out.io.err(`  ${statusLine(s)}\n`);
        }
      }
      if (s.cancelRequested && !saidStopping) {
        saidStopping = true;
        out.io.err("Stopping after the boards in flight (Ctrl-C again to quit now)…\n");
      }
    },
    stop() {},
  };
}

function jsonEvents(out: Out): SyncProgressView {
  let lastAt = 0;
  let lastKey = "";
  return {
    update(s) {
      const key = `${s.status}:${s.phase}:${s.phases.map((p) => p.status[0]).join("")}:${s.cancelRequested}`;
      const now = Date.now();
      if (key === lastKey && now - lastAt < 500) return;
      lastKey = key;
      lastAt = now;
      const event = {
        type: "sync.progress",
        runId: s.runId,
        status: s.status,
        phase: s.phase,
        phases: Object.fromEntries(s.phases.map((p) => [p.id, p.status])),
        boards: { done: s.boards.done, failed: s.boards.failed, total: s.boards.total, skipped: s.boards.skipped, inFlight: s.boards.inFlight },
        feeds: s.feeds,
        postings: s.postings,
        elapsedMs: s.timing.elapsedMs,
        etaMs: s.timing.etaMs,
        cancelRequested: s.cancelRequested,
      };
      out.io.err(JSON.stringify(event) + "\n");
    },
    stop() {},
  };
}
