import type { RawPosting } from "@jobflow/core";
import { adapterNotice, COUNTRY_NAMES, DETAIL_CAP, markPartial, pickForDetail, htmlToText, httpJsonPolite, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Eightfold careers APIs (Tier 2: the JSON the careers site calls, no auth). Two
 * generations, told apart by the slug:
 *   "{host}/{domain}"     PCSX — Microsoft, Qualcomm, Vodafone, Lam Research, Infineon…
 *   "{host}/{domain}/v2"  the older /api/apply/v2 — HSBC, Bayer, NetApp (tenants not yet
 *                         migrated: their PCSX answers 403 "PCSX is not enabled").
 * Verified live 2026-09:
 *   GET https://{host}/api/pcsx/search?domain=…&location=India&start=N&num=…&sort_by=timestamp
 *   GET https://{host}/api/pcsx/position_details?position_id=…&domain=…&hl=en   (JD)
 *   GET https://{host}/api/apply/v2/jobs?domain=…&location=India&start=N&num=10&sort_by=timestamp
 *   GET https://{host}/api/apply/v2/jobs/{id}?domain=…                        (JD)
 * (Migrated tenants answer 403 "Not authorized for PCSX" on /api/apply/v2 — hence the
 * explicit marker rather than guessing per poll.) Both page 10 at a time whatever `num` says.
 */

export type EightfoldApi = "pcsx" | "v2";

export function parseEightfoldSlug(slug: string): { host: string; domain: string; api: EightfoldApi } | null {
  const [host, domain, marker] = slug.split("/");
  if (!host || !domain) return null;
  if (marker !== undefined && marker !== "v2") return null;
  return { host, domain, api: marker === "v2" ? "v2" : "pcsx" };
}

interface EfPosition {
  id: number;
  name: string;
  locations?: string[];
  standardizedLocations?: string[];
  postedTs?: number;
  workLocationOption?: string;
  positionUrl?: string;
}
interface EfSearch {
  data?: { positions?: EfPosition[]; count?: number };
}
interface EfDetail {
  data?: { jobDescription?: string; publicUrl?: string };
}

/** /api/apply/v2 shapes (snake_case; the JD comes from the per-job call). */
export interface EfV2Position {
  id: number;
  name: string;
  location?: string;
  locations?: string[];
  t_create?: number;
  work_location_option?: string;
  canonicalPositionUrl?: string;
}
interface EfV2Search {
  positions?: EfV2Position[];
  count?: number;
}
interface EfV2Detail {
  job_description?: string;
  canonicalPositionUrl?: string;
}

/** the API ignores larger `num` — pages are always 10. */
const PAGE = 10;
/**
 * most recent N (sorted by timestamp). A board with more is listed PARTIALLY: an older
 * req past the window may still be open, so it is left to the lastSeen TTL sweep rather
 * than diffed away by markStale (invariant #5).
 */
const MAX_LIST = 200;

/** One listing, whichever API it came from. */
export interface EfRow {
  id: number;
  title: string;
  where: string;
  mode?: string;
  postedTs?: number;
  url: string | null;
  raw: object;
}

export class EightfoldAdapter implements SourceAdapter {
  readonly source = "eightfold" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const s = target.slug ? parseEightfoldSlug(target.slug) : null;
    if (!s) return [];
    const { host, domain } = s;
    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : "";
    const headers = { Referer: `https://${host}/careers?domain=${domain}` };

    const listed = s.api === "v2" ? await listV2(host, domain, country, headers) : await listPcsx(host, domain, country, headers);
    // a failed page mid-list would make the tail look closed to markStale — all or nothing
    if (!listed) return [];
    // a req posted mid-poll shifts the timestamp-sorted pages, so a row can repeat
    const rows = [...new Map(listed.rows.map((r) => [r.id, r])).values()];

    const needDetail = pickForDetail(rows.filter((r) => !target.known?.has(String(r.id))), (r) => r.title, target.limit ?? DETAIL_CAP);
    const details = new Map<number, { html?: string; url?: string } | null>();
    await mapPool(needDetail, 2, async (r) => {
      if (s.api === "v2") {
        const d = await getPolitely<EfV2Detail>(`https://${host}/api/apply/v2/jobs/${r.id}?domain=${domain}`, headers);
        details.set(r.id, d ? { html: d.job_description, url: d.canonicalPositionUrl } : null);
      } else {
        const d = await getPolitely<EfDetail>(`https://${host}/api/pcsx/position_details?position_id=${r.id}&domain=${domain}&hl=en`, headers);
        details.set(r.id, d?.data ? { html: d.data.jobDescription, url: d.data.publicUrl } : null);
      }
    });

    const out = rows.map((r) => {
      const d = details.get(r.id);
      const mode = r.mode === "remote" ? "Remote - " : r.mode === "hybrid" ? "Hybrid - " : "";
      return {
        source: "eightfold",
        tier: "tier2",
        atsType: "eightfold",
        atsJobId: String(r.id),
        companyName: domain.split(".")[0] ?? domain,
        companySlug: target.slug!,
        title: r.title,
        jdText: htmlToText(d?.html),
        jdHtml: d?.html || null,
        locationRaw: `${mode}${r.where}${country && !r.where.includes(country) ? `, ${country}` : ""}`,
        applyUrl: d?.url || r.url,
        salaryRaw: null,
        postedAt: r.postedTs ? new Date(r.postedTs * 1000).toISOString() : null,
        fetchedAt: new Date(),
        raw: r.raw as Record<string, unknown>,
      } satisfies RawPosting;
    });
    return rows.length < listed.total ? markPartial(out) : out;
  }
}

interface EfListing {
  rows: EfRow[];
  /** the board's own count for the query (what a complete list would hold) */
  total: number;
}

async function listPcsx(host: string, domain: string, country: string, headers: Record<string, string>): Promise<EfListing | null> {
  const positions: EfPosition[] = [];
  let total = 0;
  for (let start = 0; start < MAX_LIST; start += PAGE) {
    const qs = new URLSearchParams({ domain, query: "", location: country, start: String(start), num: String(PAGE), sort_by: "timestamp" });
    const res = await getPolitely<EfSearch>(`https://${host}/api/pcsx/search?${qs}`, headers);
    if (!res) return null;
    const batch = res.data?.positions ?? [];
    positions.push(...batch);
    total = res.data?.count ?? positions.length;
    if (batch.length < PAGE || positions.length >= total) break;
  }
  const rows = positions.map((p) => ({
    id: p.id,
    title: p.name,
    where: [...(p.standardizedLocations ?? []), ...(p.locations ?? [])].join("; "),
    mode: p.workLocationOption,
    postedTs: p.postedTs,
    url: p.positionUrl ? `https://${host}${p.positionUrl}` : null,
    raw: p,
  }));
  return { rows, total };
}

async function listV2(host: string, domain: string, country: string, headers: Record<string, string>): Promise<EfListing | null> {
  const positions: EfV2Position[] = [];
  let total = 0;
  for (let start = 0; start < MAX_LIST; start += PAGE) {
    const qs = new URLSearchParams({ domain, location: country, start: String(start), num: String(PAGE), sort_by: "timestamp" });
    const res = await getPolitely<EfV2Search>(`https://${host}/api/apply/v2/jobs?${qs}`, headers);
    if (!res) return null;
    // v2 answers its whole page config ({domain, branding, facets, …, positions, count}); a
    // reply with no `positions` list at all is a changed API, not an empty board — say so.
    // (Bayer, 2026-11: `positions: []`, `count: 0` for every location, and its own careers
    // page renders the same 0 — the board is empty, which is not an adapter failure.)
    if (!Array.isArray(res.positions)) {
      adapterNotice("eightfold", `${domain}: /api/apply/v2 answered without a positions list; the tenant may have moved to PCSX (use the "{host}/{domain}" slug)`);
      return null;
    }
    positions.push(...res.positions);
    total = res.count ?? positions.length;
    if (res.positions.length < PAGE || positions.length >= total) break;
  }
  return { rows: positions.map(v2Row), total };
}

/** v2 listing → row. `t_create` is when the posting went up (not re-stamped by edits —
 *  `t_update` is), so it stands in for the publish date. */
export function v2Row(p: EfV2Position): EfRow {
  const locs = p.locations?.length ? p.locations : p.location ? [p.location] : [];
  return {
    id: p.id,
    title: p.name,
    where: locs.join("; "),
    mode: p.work_location_option,
    postedTs: p.t_create,
    url: p.canonicalPositionUrl ?? null,
    raw: { id: p.id, name: p.name, locations: locs, t_create: p.t_create },
  };
}

/**
 * Microsoft's tenant rate-limits bursts: measured 2026-11, about one request in four is a
 * 429 even at 2 s spacing, and it sends no Retry-After. The old single 4 s retry lost the
 * whole India list (0 postings). Pace every call, and back off 5 s → 10 s → 20 s on a
 * 429/503; any other failure degrades to null at once (the list is then all-or-nothing).
 */
async function getPolitely<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  await sleep(500);
  return httpJsonPolite<T>(url, { headers }, { retries: 3, baseDelayMs: 5000 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
