import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

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
/** most recent N (sorted by timestamp); older reqs age out of the window → markStale. */
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

    const rows = s.api === "v2" ? await listV2(host, domain, country, headers) : await listPcsx(host, domain, country, headers);
    // a failed page mid-list would make the tail look closed to markStale — all or nothing
    if (!rows) return [];

    const needDetail = pickForDetail(rows.filter((r) => !target.known?.has(String(r.id))), (r) => r.title, target.limit ?? DETAIL_CAP);
    const details = new Map<number, { html?: string; url?: string } | null>();
    await mapPool(needDetail, 3, async (r) => {
      if (s.api === "v2") {
        const d = await getPolitely<EfV2Detail>(`https://${host}/api/apply/v2/jobs/${r.id}?domain=${domain}`, headers);
        details.set(r.id, d ? { html: d.job_description, url: d.canonicalPositionUrl } : null);
      } else {
        const d = await getPolitely<EfDetail>(`https://${host}/api/pcsx/position_details?position_id=${r.id}&domain=${domain}&hl=en`, headers);
        details.set(r.id, d?.data ? { html: d.data.jobDescription, url: d.data.publicUrl } : null);
      }
    });

    return rows.map((r) => {
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
  }
}

async function listPcsx(host: string, domain: string, country: string, headers: Record<string, string>): Promise<EfRow[] | null> {
  const positions: EfPosition[] = [];
  for (let start = 0; start < MAX_LIST; start += PAGE) {
    const qs = new URLSearchParams({ domain, query: "", location: country, start: String(start), num: String(PAGE), sort_by: "timestamp" });
    const res = await getPolitely<EfSearch>(`https://${host}/api/pcsx/search?${qs}`, headers);
    if (!res) return null;
    const batch = res.data?.positions ?? [];
    positions.push(...batch);
    if (batch.length < PAGE || positions.length >= (res.data?.count ?? 0)) break;
  }
  return positions.map((p) => ({
    id: p.id,
    title: p.name,
    where: [...(p.standardizedLocations ?? []), ...(p.locations ?? [])].join("; "),
    mode: p.workLocationOption,
    postedTs: p.postedTs,
    url: p.positionUrl ? `https://${host}${p.positionUrl}` : null,
    raw: p,
  }));
}

async function listV2(host: string, domain: string, country: string, headers: Record<string, string>): Promise<EfRow[] | null> {
  const positions: EfV2Position[] = [];
  for (let start = 0; start < MAX_LIST; start += PAGE) {
    const qs = new URLSearchParams({ domain, location: country, start: String(start), num: String(PAGE), sort_by: "timestamp" });
    const res = await getPolitely<EfV2Search>(`https://${host}/api/apply/v2/jobs?${qs}`, headers);
    if (!res || !Array.isArray(res.positions)) return null;
    positions.push(...res.positions);
    if (res.positions.length < PAGE || positions.length >= (res.count ?? 0)) break;
  }
  return positions.map(v2Row);
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
 * Microsoft's tenant rate-limits bursts (429). Pace requests and retry once after a
 * pause rather than hammering; a second failure degrades to null (adapter returns less).
 */
async function getPolitely<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  await sleep(300);
  const first = await httpJson<T>(url, { headers });
  if (first) return first;
  await sleep(4000);
  return httpJson<T>(url, { headers });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
