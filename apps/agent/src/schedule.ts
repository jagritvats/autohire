import type { Job, JobType } from "@jobflow/core";
import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import type { EffectiveFlags } from "./flags.js";
import { LOCAL_BOARD_SOURCES, TIER3_JOB_SOURCES } from "./handlers.js";

/**
 * Unattended local polling — the agent-side twin of the worker's `maybeSchedulePoll`
 * (§3 freshness). Nothing else enqueues local jobs except a click in the web UI, so the
 * Tier-3 feeds and local-only boards (Darwinbox) went stale whenever nobody clicked.
 * When the browser is on (env JOBFLOW_BROWSER=on AND the web master switch — i.e. it
 * inherits the default-OFF gates) and a source's last run is older than `everyHours`,
 * enqueue one job for it: `tier3_poll` per opted-in job source, `local_board_poll` per
 * opted-in board ATS. The drain loop then runs them one at a time, human-paced.
 */

/** default cadence: twice a day is plenty for sources polled through your own browser. */
export const DEFAULT_LOCAL_POLL_EVERY_HOURS = 12;

/** JOBFLOW_LOCAL_POLL_EVERY_HOURS (hours; 0 = off). Unset/invalid → the default. */
export function localPollEveryHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOBFLOW_LOCAL_POLL_EVERY_HOURS;
  if (raw == null || raw.trim() === "") return DEFAULT_LOCAL_POLL_EVERY_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOCAL_POLL_EVERY_HOURS;
}

/** a job still "running" after this was orphaned by a crashed agent — don't let it block. */
const STUCK_RUNNING_MS = 6 * 3_600_000;

export interface PlannedLocalJob {
  type: Extract<JobType, "tier3_poll" | "local_board_poll">;
  source: string;
}

/**
 * Pure decision: which (type, source) jobs are due, given the recent job log. A source
 * is skipped while a job for it is still queued/running (no pile-up behind a slow
 * sweep), or when its last job — scheduled or clicked — is younger than `everyHours`.
 */
export function dueLocalJobs(
  recent: Array<Pick<Job, "type" | "payload" | "status" | "createdAt">>,
  enabledSources: string[],
  everyHours: number,
  now = Date.now(),
): PlannedLocalJob[] {
  if (!(everyHours > 0)) return [];
  const out: PlannedLocalJob[] = [];
  for (const source of enabledSources) {
    const type = (TIER3_JOB_SOURCES as readonly string[]).includes(source)
      ? "tier3_poll"
      : LOCAL_BOARD_SOURCES.includes(source)
        ? "local_board_poll"
        : null; // ambitionbox / glassdoor are enrichment, run per company
    if (!type) continue;
    // `recent` is newest-first (listJobs); a board job without `source` covered every board
    const last = recent.find(
      (j) =>
        j.type === type &&
        (type === "tier3_poll" ? j.payload.source === source : !j.payload.companyId && (!j.payload.source || j.payload.source === source)),
    );
    const age = last ? now - new Date(last.createdAt as string | Date).getTime() : Infinity;
    if (last?.status === "queued") continue; // runs when drained — don't stack another
    if (last?.status === "running" && age < STUCK_RUNNING_MS) continue; // older = agent died mid-job
    if (age < everyHours * 3_600_000) continue;
    out.push({ type, source });
  }
  return out;
}

/** Enqueue whatever is due. Returns what was enqueued (for the log). */
export async function maybeScheduleLocalPolls(
  repo: Repository,
  everyHours: number,
  flags: EffectiveFlags,
  log: (...a: unknown[]) => void,
): Promise<PlannedLocalJob[]> {
  if (!flags.browserOn || !(everyHours > 0)) return [];
  const recent = await repo.listJobs(DEFAULT_TENANT, 200);
  const due = dueLocalJobs(recent, flags.enabledSources, everyHours);
  for (const d of due) {
    await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type: d.type, runtime: JOB_RUNTIME[d.type], payload: { source: d.source, scheduled: true } });
  }
  if (due.length) log(`⏰ scheduled ${due.map((d) => `${d.type}:${d.source}`).join(", ")} (every ${everyHours}h)`);
  return due;
}
