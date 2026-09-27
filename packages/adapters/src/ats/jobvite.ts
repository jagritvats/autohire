import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, decodeEntities, htmlToText, httpText, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Jobvite (Tier 2: the public XML job feed behind a company's Jobvite careers site,
 * no auth) — Nutanix (large Bengaluru/Pune engineering) and others.
 * slug = the path segment in jobs.jobvite.com/{slug}. Verified live 2026-09:
 *   GET https://jobs.jobvite.com/{slug}/jobs          → "companyEId: '…'" in the page
 *   GET https://app.jobvite.com/CompanyJobs/Xml.aspx?c={companyEId}   → every job, JD inline
 * Multi-location reqs appear as child rows "{id}-{suffix}"; they are folded into one
 * posting. The feed is large (≈6 MB for ~400 jobs), so it is filtered to the poll
 * country here.
 */

interface JvJob {
  id: string;
  title: string;
  category: string;
  region: string;
  location: string;
  date: string;
  description: string;
  applyUrl: string;
  detailUrl: string;
}

export class JobviteAdapter implements SourceAdapter {
  readonly source = "jobvite" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug?.replace(/[^a-z0-9_-]/gi, "");
    if (!slug) return [];
    const page = await httpText(`https://jobs.jobvite.com/${slug}/jobs`);
    const eid = page?.match(/companyEId\s*[:=]\s*['"]([A-Za-z0-9]+)['"]/)?.[1];
    if (!eid) return [];
    const xml = await httpText(`https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${eid}`, { timeoutMs: 60_000 });
    if (!xml) return [];

    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;
    const byId = new Map<string, JvJob[]>();
    for (const job of parseJobviteXml(xml)) {
      const base = job.id.split("-")[0]!;
      byId.set(base, [...(byId.get(base) ?? []), job]);
    }

    const out: RawPosting[] = [];
    for (const [id, rows] of byId) {
      const places = [...new Set(rows.map((r) => r.location).filter(Boolean))];
      const regions = rows.map((r) => r.region);
      if (country && !places.some((p) => p.includes(country)) && !regions.includes(country)) continue;
      const first = rows[0]!;
      const posted = parseUsDate(first.date);
      out.push({
        source: "jobvite",
        tier: "tier2",
        atsType: "jobvite",
        atsJobId: id,
        companyName: slug,
        companySlug: slug,
        title: first.title,
        jdText: htmlToText(first.description),
        jdHtml: first.description || null,
        locationRaw: places.join("; ") || null,
        applyUrl: first.applyUrl || `https://jobs.jobvite.com/${slug}/job/${id}/apply`,
        salaryRaw: null,
        postedAt: posted,
        fetchedAt: new Date(),
        raw: { id, category: first.category } as Record<string, unknown>,
      });
    }
    return out;
  }
}

/** Minimal parse of Jobvite's flat <job> feed (no attributes, CDATA or entity-escaped text). */
export function parseJobviteXml(xml: string): JvJob[] {
  const field = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m?.[1]) return "";
    const cdata = m[1].match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return decodeEntities(cdata?.[1] ?? m[1]).trim();
  };
  const jobs: JvJob[] = [];
  for (const m of xml.matchAll(/<job>([\s\S]*?)<\/job>/g)) {
    const b = m[1]!;
    const id = field(b, "id");
    if (!id) continue;
    jobs.push({
      id,
      title: field(b, "title"),
      category: field(b, "category"),
      region: field(b, "region"),
      location: field(b, "location"),
      date: field(b, "date"),
      description: field(b, "description"),
      applyUrl: field(b, "apply-url"),
      detailUrl: field(b, "detail-url"),
    });
  }
  return jobs;
}

/** "8/27/2026" (M/D/YYYY) → ISO. */
function parseUsDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
