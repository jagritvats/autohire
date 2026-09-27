import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * iCIMS Jibe career sites (Tier 2: the JSON the careers site itself calls, no auth) —
 * PepsiCo (pepsicojobs.com) and Keysight (jobs.keysight.com) among others; the ATS behind
 * them is usually iCIMS, which has no public API of its own. slug = the careers host,
 * e.g. "jobs.keysight.com". Verified live 2026-09:
 *   GET https://{host}/api/jobs?country=India&page=N&limit=100&sortBy=posted_date&descending=true
 * `country` is the site's exact country facet (a bare `location=India` is a geo search
 * that leaks other countries). Rows carry the full JD as plain text, so there is no
 * per-posting detail call. `posted_date` is the ATS posting date — iCIMS re-stamps it
 * on a repost (req ids are creation-ordered, so id order exposes it); `create_date` /
 * `update_date` are Jibe's own import times and are re-stamped on every sync.
 */

export interface JibeJob {
  req_id?: string | number;
  slug?: string;
  title?: string;
  description?: string;
  responsibilities?: string;
  qualifications?: string;
  location_name?: string;
  city?: string;
  state?: string;
  country?: string;
  full_location?: string;
  additional_locations?: Array<{ city?: string; state?: string; country?: string }>;
  categories?: Array<{ name?: string }>;
  hiring_organization?: string;
  posted_date?: string;
  apply_url?: string;
  ats_code?: string;
  meta_data?: { canonical_url?: string };
}
export interface JibeList {
  jobs?: Array<{ data?: JibeJob }>;
  totalCount?: number;
}

const PAGE = 100;
const HTML_TAG = /<\/?[a-z][^>]*>/i;
/** newest first (sortBy=posted_date); a board past this ages its oldest reqs out → markStale. */
const MAX_LIST = 1000;

export class JibeAdapter implements SourceAdapter {
  readonly source = "jibe" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const host = target.slug?.trim();
    if (!host || host.includes("/")) return [];
    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;

    const jobs: JibeJob[] = [];
    let total = Infinity;
    for (let page = 1; (page - 1) * PAGE < Math.min(total, MAX_LIST); page++) {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE), sortBy: "posted_date", descending: "true" });
      if (country) qs.set("country", country);
      const res = await httpJson<JibeList>(`https://${host}/api/jobs?${qs}`, { timeoutMs: 30_000 });
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!res || !Array.isArray(res.jobs)) return [];
      total = res.totalCount ?? 0;
      const batch = res.jobs.map((j) => j.data).filter((d): d is JibeJob => !!d?.title);
      jobs.push(...batch);
      if (res.jobs.length < PAGE) break;
    }
    return parseJibeJobs(jobs, host, country);
  }
}

/** Jibe rows → RawPostings (pure; exported for fixture tests). */
export function parseJibeJobs(jobs: JibeJob[], host: string, country: string | null): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const j of jobs) {
    const id = String(j.req_id ?? j.slug ?? "");
    if (!id || !j.title || seen.has(id)) continue;
    seen.add(id);
    const primary = [j.city, j.state, j.country].filter(Boolean).join(", ") || j.full_location || "";
    const extra = (j.additional_locations ?? []).map((l) => [l.city, l.state, l.country].filter(Boolean).join(", ")).filter(Boolean);
    const locs = [...new Set([primary, ...extra].filter(Boolean))].join("; ");
    const remote = /\bremote\b/i.test(`${j.location_name ?? ""} ${j.full_location ?? ""}`);
    const desc = j.description?.trim() ?? "";
    // the description usually already embeds both sections; append only what's missing
    const more = [j.responsibilities, j.qualifications].filter((x): x is string => !!x?.trim() && !desc.includes(x.trim().slice(0, 80)));
    // most rows are plain text, some tenants' (Keysight) are HTML
    const parts = [desc, ...more].filter(Boolean);
    const html = parts.some((p) => HTML_TAG.test(p));
    out.push({
      source: "jibe",
      tier: "tier2",
      atsType: "jibe",
      atsJobId: id,
      companyName: j.hiring_organization || host.replace(/^(www|jobs|careers)\./, "").split(".")[0] || host,
      companySlug: host,
      title: j.title.trim(),
      jdText: parts.map((p) => (HTML_TAG.test(p) ? htmlToText(p) : p)).join("\n\n"),
      jdHtml: html ? parts.join("\n") : null,
      locationRaw: `${remote ? "Remote - " : ""}${locs}${country && !locs.includes(country) ? `${locs ? ", " : ""}${country}` : ""}` || null,
      applyUrl: j.meta_data?.canonical_url ?? `https://${host}/jobs/${j.slug ?? id}`,
      salaryRaw: null,
      postedAt: jibeDate(j.posted_date),
      fetchedAt: new Date(),
      raw: { req_id: id, categories: (j.categories ?? []).map((c) => c.name), ats: j.ats_code } as Record<string, unknown>,
    });
  }
  return out;
}

/** "2026-09-15T14:52:00+0000" → ISO (the offset lacks the colon strict parsers expect). */
function jibeDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
