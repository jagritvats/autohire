import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Eightfold PCSX careers API (Tier 2: the JSON the careers site calls, no auth).
 * Behind Microsoft's and Qualcomm's careers sites, among others. slug = "{host}/{domain}",
 * e.g. "apply.careers.microsoft.com/microsoft.com". Verified live 2026-09:
 *   GET https://{host}/api/pcsx/search?domain=…&location=India&start=N&num=…&sort_by=timestamp
 *   GET https://{host}/api/pcsx/position_details?position_id=…&domain=…&hl=en   (JD)
 * (The older /api/apply/v2/jobs answers 403 "Not authorized for PCSX" on migrated tenants.)
 */

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

/** the API ignores larger `num` — pages are always 10. */
const PAGE = 10;
/** most recent N (sorted by timestamp); older reqs age out of the window → markStale. */
const MAX_LIST = 200;

export class EightfoldAdapter implements SourceAdapter {
  readonly source = "eightfold" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const [host, domain] = (target.slug ?? "").split("/");
    if (!host || !domain) return [];
    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : "";
    const headers = { Referer: `https://${host}/careers?domain=${domain}` };

    const positions: EfPosition[] = [];
    for (let start = 0; start < MAX_LIST; start += PAGE) {
      const qs = new URLSearchParams({ domain, query: "", location: country, start: String(start), num: String(PAGE), sort_by: "timestamp" });
      const res = await getPolitely<EfSearch>(`https://${host}/api/pcsx/search?${qs}`, headers);
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!res) return [];
      const batch = res?.data?.positions ?? [];
      positions.push(...batch);
      if (batch.length < PAGE || positions.length >= (res?.data?.count ?? 0)) break;
    }

    const needDetail = pickForDetail(positions.filter((p) => !target.known?.has(String(p.id))), (p) => p.name, target.limit ?? DETAIL_CAP);
    const details = new Map<number, EfDetail | null>();
    await mapPool(needDetail, 3, async (p) =>
      details.set(
        p.id,
        await getPolitely<EfDetail>(`https://${host}/api/pcsx/position_details?position_id=${p.id}&domain=${domain}&hl=en`, headers),
      ),
    );

    return positions.map((p) => {
      const d = details.get(p.id)?.data;
      const where = [...(p.standardizedLocations ?? []), ...(p.locations ?? [])].join("; ");
      const mode = p.workLocationOption === "remote" ? "Remote - " : p.workLocationOption === "hybrid" ? "Hybrid - " : "";
      return {
        source: "eightfold",
        tier: "tier2",
        atsType: "eightfold",
        atsJobId: String(p.id),
        companyName: domain.split(".")[0] ?? domain,
        companySlug: target.slug!,
        title: p.name,
        jdText: htmlToText(d?.jobDescription),
        jdHtml: d?.jobDescription ?? null,
        locationRaw: `${mode}${where}${country && !where.includes(country) ? `, ${country}` : ""}`,
        applyUrl: d?.publicUrl ?? (p.positionUrl ? `https://${host}${p.positionUrl}` : null),
        salaryRaw: null,
        postedAt: p.postedTs ? new Date(p.postedTs * 1000).toISOString() : null,
        fetchedAt: new Date(),
        raw: p as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
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
