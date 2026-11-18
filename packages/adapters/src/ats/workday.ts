import { countryCodeFromText, type RawPosting } from "@jobflow/core";
import { adapterNotice, markPartial, COUNTRY_NAMES, DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Workday CXS (Tier 2: the public JSON the careers site itself calls, no auth). The
 * backend of most large employers with India engineering centres (Nvidia, Salesforce,
 * Adobe, PayPal, Target…). One generic adapter; the slug encodes the tenant:
 *   slug = "{host}/{tenant}/{site}", e.g. "nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite"
 * Verified live 2026-09:
 *   POST https://{host}/wday/cxs/{tenant}/{site}/jobs   {appliedFacets, limit≤20, offset, searchText}
 *   GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath}   (JD + startDate)
 * `searchText` is fuzzy ("India" matches Indiana), so the country is applied through the
 * tenant's own location facet — whose name varies by tenant — found by descriptor.
 */

interface WdFacetValue {
  descriptor?: string;
  id?: string;
  count?: number;
  facetParameter?: string;
  values?: WdFacetValue[];
}
interface WdFacet {
  facetParameter: string;
  values?: WdFacetValue[];
}
interface WdJob {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
interface WdList {
  total?: number;
  jobPostings?: WdJob[];
  facets?: WdFacet[];
}
interface WdDetail {
  jobPostingInfo?: {
    jobDescription?: string;
    startDate?: string;
    location?: string;
    additionalLocations?: string[];
    country?: { descriptor?: string };
    externalUrl?: string;
    remoteType?: string;
  };
}

const PAGE = 20;
const MAX_LIST = 400;

export function parseWorkdaySlug(slug: string): { host: string; tenant: string; site: string } | null {
  const [host, tenant, site] = slug.split("/");
  return host && tenant && site ? { host, tenant, site } : null;
}

export class WorkdayAdapter implements SourceAdapter {
  readonly source = "workday" as const;
  readonly tier = "tier2" as const;

  /**
   * The CXS detail call for the posting's own path (taken from its apply URL): 404
   * "not found: Job_Posting_Anchor_ID" once the req is removed (verified 2026-09).
   */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const t = job.slug ? parseWorkdaySlug(job.slug) : null;
    const path = job.applyUrl?.match(/(\/job\/[^?#]+)/)?.[1];
    if (!t || !path) return null;
    return liveFromStatus(await httpStatus(`https://${t.host}/wday/cxs/${t.tenant}/${t.site}${path}`));
  }

  /**
   * Total: a tenant's malformed answer (a redacted row, a non-array field) must cost that
   * one board's poll, never throw into the pipeline. A throw is "unknown" ([]), so ingest
   * never diffs against it (invariant #5).
   */
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    try {
      return await this.fetchBoard(target);
    } catch (e) {
      adapterNotice("workday", `${target.slug ?? "?"}: unexpected answer (${(e as Error)?.message ?? e}); skipped this poll`);
      return [];
    }
  }

  private async fetchBoard(target: FetchTarget): Promise<RawPosting[]> {
    const t = target.slug ? parseWorkdaySlug(target.slug) : null;
    if (!t) return [];
    const api = `https://${t.host}/wday/cxs/${t.tenant}/${t.site}`;
    const post = (body: object) =>
      httpJson<WdList>(`${api}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: PAGE, searchText: "", ...body }),
        timeoutMs: 25_000,
      });

    let appliedFacets: Record<string, string[]> = {};
    const countryName = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;
    // no country facet or site matched: list the board unfiltered (capped) and keep rows
    // whose location text doesn't place them elsewhere — never a silent [] for a live board
    let unfiltered = false;
    if (countryName) {
      const first = await post({ appliedFacets: {}, offset: 0 });
      if (!first) return []; // the board didn't answer — nothing to diff against
      const facet = findCountryFacet(first.facets ?? [], countryName);
      // some tenants (Comcast) have no country facet, only sites named "India - Chennai, …"
      // or "India Remote"
      const sites = facet ? null : findCountrySites(first.facets ?? [], countryName);
      if (facet) appliedFacets = { [facet.param]: [facet.id] };
      else if (sites) appliedFacets = { [sites.param]: sites.ids };
      else unfiltered = true;
    }

    const jobs: WdJob[] = [];
    let total = Infinity; // Workday reports `total` on the first page only (later pages say 0)
    const cap = unfiltered ? MAX_UNFILTERED : MAX_LIST;
    for (let offset = 0; offset < Math.min(cap, total); offset += PAGE) {
      const page = await post({ appliedFacets, offset });
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!page) return [];
      const batch = Array.isArray(page.jobPostings) ? page.jobPostings.filter((j): j is WdJob => !!j && typeof j === "object") : [];
      if (offset === 0) total = page?.total ?? 0;
      jobs.push(...batch);
      if (batch.length < PAGE) break;
    }
    // the list stopped at the cap with more on the board: a diff against it would stale the
    // tail (invariant #5) — say so, and let ingest skip markStale (the TTL sweep retires).
    // Counted over EVERY row received, redacted ones included: `total` counts them too.
    const truncated = Number.isFinite(total) && jobs.length < total;
    const { rows: identified, redactedKnown } = splitRedacted(jobs, target.known);
    const kept = unfiltered && countryName ? identified.filter((j) => !placedElsewhere(j.locationsText, target.location!, countryName)) : identified;

    const needDetail = pickForDetail(kept.filter((j) => !target.known?.has(idOf(j))), (j) => j.title, target.limit ?? DETAIL_CAP);
    const details = new Map<string, WdDetail | null>();
    await mapPool(needDetail, 3, async (j) => details.set(j.externalPath, await httpJson<WdDetail>(`${api}${j.externalPath}`)));

    const out = kept.map((j) => {
      const info = details.get(j.externalPath)?.jobPostingInfo;
      const extra = Array.isArray(info?.additionalLocations) ? info.additionalLocations : [];
      const locs = [info?.location ?? j.locationsText, ...extra].filter((x): x is string => typeof x === "string" && !!x);
      const remote = /remote/i.test(info?.remoteType ?? "") || /\bremote\b/i.test(locs.join(" "));
      return {
        source: "workday",
        tier: "tier2",
        atsType: "workday",
        atsJobId: idOf(j),
        companyName: t.tenant,
        companySlug: target.slug!,
        title: j.title.trim(),
        jdText: htmlToText(info?.jobDescription),
        jdHtml: info?.jobDescription ?? null,
        // Workday location strings are often "IND - Bangalore" — append the country name when
        // the country filter put the row there (an unfiltered row's country is only its text)
        locationRaw: `${remote ? "Remote - " : ""}${locs.join("; ")}${countrySuffix(locs.join(" "), unfiltered, target.location, countryName)}`,
        applyUrl: info?.externalUrl ?? `https://${t.host}/${t.site}${j.externalPath}`,
        salaryRaw: null,
        postedAt: info?.startDate ?? relativePosted(j.postedOn),
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
    // A redacted row whose id matches a posting we already store means that posting is still
    // on the board, only hidden in this answer: diffing would retire it, so don't (§3).
    return truncated || unfiltered || redactedKnown ? markPartial(out) : out;
  }
}

type WdRow = WdJob & { title: string; externalPath: string };

/** Workday's job id: the path's trailing "_R-12345" / "_1216477-2". */
function idOf(j: WdRow): string {
  return j.externalPath.match(/_([A-Za-z0-9-]+)$/)?.[1] ?? j.externalPath;
}

/**
 * Some tenants (Mastercard, PwC, HPE, Citi… seen 2026-11) put REDACTED rows in the list:
 * `{"bulletFields":["R-293658"]}` with no title and no path. There is nothing to show or
 * apply to, and the detail endpoint can't be reached without the path, so such a row is
 * skipped — it used to throw in `idOf` and lose the whole board.
 *
 * Staleness (invariant #5): the board's `total` counts redacted rows, so the "did we list
 * everything" check above runs over every row received and a skipped row never makes a
 * complete list look complete when it isn't. A complete list minus its redacted rows is
 * still a safe diff: a redacted row's id never appears as a normal row, so the only posting
 * a diff could retire is one the board no longer lets anyone open. The exception is a
 * redacted row whose bullet id matches a posting we already store (`known`): that posting
 * is still listed, only hidden in this answer, so the fetch is marked partial instead.
 * Workday paths carry a repost suffix ("1216477-2") the bullet id lacks, hence the prefix.
 */
export function splitRedacted(jobs: WdJob[], known?: ReadonlySet<string>): { rows: WdRow[]; redacted: number; redactedKnown: boolean } {
  const rows: WdRow[] = [];
  const hidden: string[] = [];
  for (const j of jobs) {
    if (typeof j.externalPath === "string" && j.externalPath && typeof j.title === "string" && j.title.trim()) rows.push(j as WdRow);
    else hidden.push(...(j.bulletFields ?? []).map((b) => String(b).trim()).filter(Boolean));
  }
  const redacted = jobs.length - rows.length;
  const knownIds = known ? [...known] : [];
  const redactedKnown = hidden.some((b) => knownIds.some((k) => k === b || k.startsWith(`${b}-`)));
  return { rows, redacted, redactedKnown };
}

/** an unfiltered fallback list stops here (politeness; the result is marked partial). */
const MAX_UNFILTERED = 200;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ", <country>" when the country filter put the row there; for an unfiltered row only when
 * its own text places it in that country without naming it ("Bangalore" → ", India").
 */
function countrySuffix(text: string, unfiltered: boolean, location: string | undefined, countryName: string | null): string {
  if (!countryName) return "";
  if (!unfiltered) return `, ${countryName}`;
  const want = location && location.trim().length === 2 ? location.trim().toUpperCase() : null;
  return want && !namesCountry(text, countryName) && countryCodeFromText(text) === want ? `, ${countryName}` : "";
}

/** the text names the country as a whole word ("India Remote", "Pune, India" — not "Indiana"). */
function namesCountry(text: string, countryName: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${escapeRe(countryName)}($|[^\\p{L}])`, "iu").test(text);
}

/**
 * Unfiltered-fallback row filter: drop a row only when its location text CONFIDENTLY places
 * it in another country; "2 Locations" / "Remote" / an unknown city stay (invariant #4 —
 * shaping the poll, never guessing a row away).
 */
function placedElsewhere(text: string | undefined, location: string, countryName: string): boolean {
  const t = (text ?? "").trim();
  if (!t || namesCountry(t, countryName)) return false;
  const want = location.trim().length === 2 ? location.trim().toUpperCase() : null;
  const code = countryCodeFromText(t);
  if (!code) return false;
  return want ? code !== want : true;
}

/** Walk (possibly nested) facets for a value whose descriptor is exactly the country. */
export function findCountryFacet(facets: WdFacet[], country: string): { param: string; id: string } | null {
  const want = country.toLowerCase();
  const walk = (param: string, values: WdFacetValue[] | undefined): { param: string; id: string } | null => {
    for (const v of values ?? []) {
      if (v.values) {
        const hit = walk(v.facetParameter ?? param, v.values);
        if (hit) return hit;
      } else if (v.id && v.descriptor?.trim().toLowerCase() === want) {
        return { param, id: v.id };
      }
    }
    return null;
  };
  for (const f of facets) {
    const hit = walk(f.facetParameter, f.values);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fallback for tenants without a country facet: every location value NAMED for the
 * country — "India - Chennai, …", "India – Virtual – Karnataka", "Pune, India", "India
 * Remote", "Remote (India)" — under one facet. The country must stand as a whole word, so
 * "IN - Indianapolis" / "Indiana" never match.
 */
export function findCountrySites(facets: WdFacet[], country: string): { param: string; ids: string[] } | null {
  const c = country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[^\\p{L}])${c}($|[^\\p{L}])`, "iu");
  const hits = new Map<string, string[]>();
  const walk = (param: string, values: WdFacetValue[] | undefined) => {
    for (const v of values ?? []) {
      if (v.values) walk(v.facetParameter ?? param, v.values);
      else if (v.id && named.test(v.descriptor?.trim() ?? "")) hits.set(param, [...(hits.get(param) ?? []), v.id]);
    }
  };
  for (const f of facets) walk(f.facetParameter, f.values);
  const best = [...hits.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best ? { param: best[0], ids: best[1] } : null;
}

/** "Posted Today" / "Posted Yesterday" / "Posted 14 Days Ago" / "Posted 30+ Days Ago" → ISO. */
export function relativePosted(text: string | undefined, now = Date.now()): string | null {
  if (!text) return null;
  const s = text.toLowerCase();
  const days = /today/.test(s) ? 0 : /yesterday/.test(s) ? 1 : Number(s.match(/(\d+)\+?\s*days?/)?.[1] ?? NaN);
  if (!Number.isFinite(days)) return null;
  return new Date(now - days * 86_400_000).toISOString();
}
