import type { Posting, RawPosting } from "../schema/entities.js";
import type { SourceKind } from "../schema/enums.js";

/**
 * Boards that allocate job ids in creation order AND reset the "posted" date when a job
 * is reposted (§3): Oracle requisition ids, Keka job ids, Atlassian listing ids, and the
 * career sites fronting iCIMS (Jibe — 27 of PepsiCo's 232 India rows looked re-stamped)
 * and Taleo (TalentBrew). An old req re-stamped with today's date still carries its old
 * id — that's the tell.
 */
export const ID_ORDERED_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>(["oracle", "keka", "atlassian", "jibe", "talentbrew"]);

/**
 * A req is often created weeks before it's published (approvals), so a lower id with a
 * somewhat later date is normal. Only a gap past this is read as a repost.
 */
export const ID_ORDER_SLACK_DAYS = 30;

const DAY = 86_400_000;

export interface DatedId {
  id: string;
  /** the earliest date we know for the job (ISO), or null when we have none */
  date: string | null;
}

/**
 * Repost-proof dates from id order (§3). A job with a lower id was created before every
 * job with a higher id, so it can't have first been published much after them. Returns
 * id → an earlier date bound, only where the job's own date (or "now", when it has none)
 * is more than `slackDays` later than that bound. The bound is the SECOND-earliest date
 * among higher ids, so one mis-dated neighbour can't age a whole board.
 */
export function idOrderPostedBounds(items: DatedId[], now = Date.now(), slackDays = ID_ORDER_SLACK_DAYS): Map<string, string> {
  const out = new Map<string, string>();
  const numeric = items
    .filter((i) => /^\d{1,30}$/.test(i.id))
    .map((i) => ({ id: BigInt(i.id), key: i.id, t: i.date ? Date.parse(i.date) : NaN }))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // highest id first
  let m1 = Infinity; // earliest date among higher ids
  let m2 = Infinity; // second-earliest
  for (const it of numeric) {
    const own = Number.isFinite(it.t) ? it.t : now;
    let effective = own;
    if (Number.isFinite(m2) && own - m2 > slackDays * DAY) {
      out.set(it.key, new Date(m2).toISOString());
      effective = m2;
    }
    if (Number.isFinite(it.t) || effective !== own) {
      if (effective < m1) [m1, m2] = [effective, m1];
      else if (effective < m2) m2 = effective;
    }
  }
  return out;
}

/**
 * Publish dates for a freshly fetched board, before upsert (§3). Mutates nothing; returns
 * id → the `postedAt` to write, for the raws that need a different one:
 *  - id order (ID_ORDERED_SOURCES): an old req re-stamped as new gets its earlier bound;
 *  - observed appearance: a board that gives no date at all (Atlassian) — a job that
 *    wasn't on the board at our previous poll was published since, so "now" is a real
 *    date. Only once the board has been polled before; on the first poll every job is
 *    new to us and its age is genuinely unknown (left null).
 * `stored` = the board's postings we already hold, keyed by scoped id.
 */
export function repostSafeDates(
  source: SourceKind,
  raws: Array<{ id: string; raw: Pick<RawPosting, "postedAt"> }>,
  stored: ReadonlyMap<string, Pick<Posting, "postedAt" | "firstSeen">>,
  now = Date.now(),
): Map<string, string> {
  const out = new Map<string, string>();
  const idOrdered = ID_ORDERED_SOURCES.has(source);
  if (stored.size > 0) {
    // on an id-ordered board "new" also means a higher id than anything stored — so a job
    // we merely never stored before (a capped refresh) isn't mistaken for a new one
    const maxStored = idOrdered ? maxNumericId([...stored.keys()]) : null;
    for (const { id, raw } of raws) {
      if (raw.postedAt != null || stored.has(id)) continue;
      if (maxStored != null && !(/^\d{1,30}$/.test(id) && BigInt(id) > maxStored)) continue;
      out.set(id, new Date(now).toISOString());
    }
  }
  if (idOrdered) {
    const items: DatedId[] = raws.map(({ id, raw }) => {
      const prev = stored.get(id);
      return { id, date: earliest(raw.postedAt, prev?.postedAt, prev?.firstSeen, out.get(id)) };
    });
    for (const [id, bound] of idOrderPostedBounds(items, now)) out.set(id, bound);
  }
  return out;
}

function maxNumericId(ids: string[]): bigint | null {
  let max: bigint | null = null;
  for (const id of ids) {
    if (!/^\d{1,30}$/.test(id)) continue;
    const n = BigInt(id);
    if (max == null || n > max) max = n;
  }
  return max;
}

function earliest(...ds: Array<string | Date | null | undefined>): string | null {
  let best = Infinity;
  for (const d of ds) {
    if (d == null || d === "") continue;
    const t = new Date(d).getTime();
    if (Number.isFinite(t) && t < best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}
