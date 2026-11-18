import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, DETAIL_CAP, markPartial, decodeEntities, htmlToText, httpJson, httpText, mapPool, pickForDetail, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Radancy TalentBrew career sites (Tier 2: the JSON endpoint the site's own search page
 * calls, no auth) — UnitedHealth Group / Optum (careers.unitedhealthgroup.com; Taleo
 * behind it) and Intuit (jobs.intuit.com; Avature behind it), among many others.
 * slug = the careers host. Verified live 2026-09:
 *   GET https://{host}/search-jobs/results?…&CurrentPage=N&RecordsPerPage=100
 *       &FacetFilters[0].ID={GeoNames country id}&FacetFilters[0].FacetType=2&…
 *     → { results: "<html fragment>", hasJobs } — the listing is server-rendered HTML
 *       inside the JSON; each job is an <a href="/job/{city}/{slug}/{orgId}/{jobId}">.
 *   GET https://{host}/job/…   → the job page; its schema.org JobPosting JSON-LD (the
 *       structured data published for search engines) carries the JD, datePosted, places.
 * The country facet is keyed by GeoNames id; an id the tenant has no jobs for returns an
 * empty list (never the whole board). The module-name params are required — without
 * them the endpoint answers with empty HTML.
 */

/** GeoNames country ids — TalentBrew's country facet keys. */
const GEONAMES_COUNTRY: Record<string, string> = {
  IN: "1269750",
  US: "6252001",
  GB: "2635167",
  DE: "2921044",
  SG: "1880251",
  AE: "290557",
  CA: "6251999",
};

const PAGE = 100;
const MAX_LIST = 1000;

export interface TbListItem {
  path: string;
  jobId: string;
  title: string;
  location: string;
}
interface TbResults {
  results?: string;
  hasJobs?: boolean;
}
export interface TbJobPosting {
  title?: string;
  description?: string;
  datePosted?: string;
  identifier?: string | { value?: string };
  jobLocationType?: string;
  jobLocation?: TbPlace | TbPlace[];
  hiringOrganization?: { name?: string };
}
interface TbPlace {
  address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } };
}

export class TalentBrewAdapter implements SourceAdapter {
  readonly source = "talentbrew" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const host = target.slug?.trim();
    if (!host || host.includes("/")) return [];
    const iso = target.location?.toUpperCase();
    const geo = iso ? GEONAMES_COUNTRY[iso] : undefined;
    if (iso && !geo) return []; // unmapped country: never fall back to the global board
    const countryName = iso ? COUNTRY_NAMES[iso] ?? iso : null;

    const items: TbListItem[] = [];
    let pages = Infinity;
    let fetchedPages = 0;
    for (let page = 1; page <= pages && (page - 1) * PAGE < MAX_LIST; page++) {
      fetchedPages = page;
      const res = await httpJson<TbResults>(`https://${host}/search-jobs/results?${talentBrewQuery(page, geo)}`, {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        timeoutMs: 30_000,
      });
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!res || typeof res.results !== "string") return [];
      if (res.hasJobs === false) break;
      const parsed = parseTalentBrewResults(res.results);
      if (page === 1) pages = parsed.pages || 1;
      items.push(...parsed.items);
      if (parsed.items.length === 0) break;
    }
    const unique = [...new Map(items.map((i) => [i.jobId, i])).values()];

    const needDetail = pickForDetail(unique.filter((i) => !target.known?.has(i.jobId)), (i) => i.title, target.limit ?? DETAIL_CAP);
    const details = new Map<string, TbJobPosting>();
    await mapPool(needDetail, 3, async (i) => {
      const html = await httpText(`https://${host}${i.path}`, { timeoutMs: 20_000, headers: { Accept: "text/html" } });
      const jp = html ? jobPostingLd(html) : null;
      if (jp) details.set(i.jobId, jp);
    });

    const company = host.replace(/^(www|jobs|careers)\./, "").split(".")[0] ?? host;
    const out = unique.map((i) => {
      const d = details.get(i.jobId);
      const places = d ? ldPlaces(d) : [];
      const where = places.length ? places.join("; ") : i.location;
      const remote = /TELECOMMUTE/i.test(d?.jobLocationType ?? "") || /\bremote\b/i.test(`${i.title} ${where}`);
      return {
        source: "talentbrew",
        tier: "tier2",
        atsType: "talentbrew",
        atsJobId: i.jobId,
        companyName: company,
        companySlug: host,
        title: i.title,
        jdText: htmlToText(d?.description),
        jdHtml: d?.description ?? null,
        locationRaw: `${remote ? "Remote - " : ""}${where}${countryName && !where.includes(countryName) ? `${where ? ", " : ""}${countryName}` : ""}` || null,
        applyUrl: `https://${host}${i.path}`,
        salaryRaw: null,
        postedAt: talentBrewDate(d?.datePosted),
        fetchedAt: new Date(),
        raw: { path: i.path, reqId: ldId(d?.identifier) } as Record<string, unknown>,
      } satisfies RawPosting;
    });
    // stopped at MAX_LIST with pages left: never a markStale diff (invariant #5)
    return fetchedPages < pages && fetchedPages * PAGE >= MAX_LIST ? markPartial(out) : out;
  }
}

/** The query the site's own search page sends (its module names are required). */
export function talentBrewQuery(page: number, geonameId?: string, perPage = PAGE): string {
  const q = new URLSearchParams({
    ActiveFacetID: "0",
    CurrentPage: String(page),
    RecordsPerPage: String(perPage),
    Distance: "50",
    RadiusUnitType: "0",
    Keywords: "",
    Location: "",
    ShowRadius: "False",
    IsPagination: "True",
    CustomFacetName: "",
    FacetTerm: "",
    FacetType: "0",
    SearchResultsModuleName: "Search Results",
    SearchFiltersModuleName: "Search Filters",
    SortCriteria: "0",
    SortDirection: "0",
    SearchType: "5",
  });
  if (geonameId) {
    q.set("FacetFilters[0].ID", geonameId);
    q.set("FacetFilters[0].FacetType", "2");
    q.set("FacetFilters[0].Count", "0");
    q.set("FacetFilters[0].Display", "");
    q.set("FacetFilters[0].IsApplied", "true");
    q.set("FacetFilters[0].FieldName", "");
  }
  return q.toString();
}

/** The search-results HTML fragment → job links (+ page count). Templates differ per
 *  tenant, but every one renders the job as an anchor to /job/…/{orgId}/{jobId} with the
 *  title in an <h2> (or data-title) and a `job-location` span. */
export function parseTalentBrewResults(html: string): { items: TbListItem[]; total: number; pages: number } {
  const total = Number(html.match(/data-total-results="(\d+)"/)?.[1] ?? 0);
  const pages = Number(html.match(/data-total-pages="(\d+)"/)?.[1] ?? 0);
  const items: TbListItem[] = [];
  for (const m of html.matchAll(/<a\b([^>]*?)href="(\/job\/[^"]*?\/(\d+)\/(\d+))"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const [, pre, path, , jobId, post, body] = m;
    const attrTitle = `${pre}${post}`.match(/data-title="([^"]*)"/)?.[1];
    const h2 = body!.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1];
    const title = clean(h2 ?? attrTitle ?? "");
    if (!title) continue;
    const location = clean(body!.match(/<span[^>]*class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    items.push({ path: path!, jobId: jobId!, title, location });
  }
  return { items, total, pages };
}

/** The schema.org JobPosting in a job page's JSON-LD (tolerates @graph / arrays). */
export function jobPostingLd(html: string): TbJobPosting | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data, ...(((data as { "@graph"?: unknown[] })?.["@graph"]) ?? [])];
    const hit = nodes.find((n) => (n as { "@type"?: string })?.["@type"] === "JobPosting");
    if (hit) return hit as TbJobPosting;
  }
  return null;
}

function ldPlaces(d: TbJobPosting): string[] {
  const places = Array.isArray(d.jobLocation) ? d.jobLocation : d.jobLocation ? [d.jobLocation] : [];
  return [
    ...new Set(
      places
        .map((p) => {
          const a = p.address ?? {};
          const country = typeof a.addressCountry === "object" ? a.addressCountry?.name : a.addressCountry;
          return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(", ");
        })
        .filter(Boolean),
    ),
  ];
}

/** TalentBrew writes unpadded dates ("2026-9-23"), which ISO parsers reject. */
export function talentBrewDate(s: string | undefined): string | null {
  const m = s?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function ldId(id: TbJobPosting["identifier"]): string | null {
  return (typeof id === "object" ? id?.value : id) ?? null;
}

function clean(s: string): string {
  const numeric = s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
  return decodeEntities(numeric).replace(/\s+/g, " ").trim();
}
