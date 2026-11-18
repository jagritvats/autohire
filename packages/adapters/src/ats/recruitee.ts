import type { LevelBand, RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, liveFromStatus, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";

/**
 * Recruitee careers API (Tier 1: the public, documented "Careers Site API", no auth) —
 * EU/Benelux SMBs and scale-ups (bunq, Channable…). slug = the {slug}.recruitee.com
 * subdomain. Verified live 2026-11:
 *   GET https://{slug}.recruitee.com/api/offers/          → { offers: [...] } every published offer, JD inline
 *   GET https://{slug}.recruitee.com/api/offers/{id}      → { offer } or 404 once unpublished
 * `published_at` is when the offer went live ("2026-11-03 20:08:14 UTC"); `created_at` is
 * the draft. `salary` is structured {min,max,currency,period} — passed on as text for the
 * salary parser to judge (it only counts as stated pay with a currency + a range).
 */

export interface RecruiteeOffer {
  id: number;
  slug?: string;
  title: string;
  status?: string;
  company_name?: string;
  description?: string;
  requirements?: string;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string | null;
  created_at?: string;
  location?: string;
  city?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  locations?: Array<{ city?: string; state?: string; country?: string; name?: string }>;
  salary?: { min?: string | number | null; max?: string | number | null; currency?: string | null; period?: string | null } | null;
  experience_code?: string | null;
  employment_type_code?: string | null;
  close_at?: string | null;
}
interface RecruiteeList {
  offers?: RecruiteeOffer[];
}

export class RecruiteeAdapter implements SourceAdapter {
  readonly source = "recruitee" as const;
  readonly tier = "tier1" as const;

  /** per-offer endpoint: 404 once unpublished (verified 2026-11); `status` other than published = closed */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const slug = recruiteeSlug(job.slug);
    if (!slug) return null;
    const r = await httpStatus(`https://${slug}.recruitee.com/api/offers/${encodeURIComponent(job.jobId)}`);
    if (r?.status !== 200) return liveFromStatus(r);
    try {
      const status = (JSON.parse(r.body) as { offer?: { status?: string } }).offer?.status;
      return status && status !== "published" ? false : true;
    } catch {
      return null;
    }
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = recruiteeSlug(target.slug);
    if (!slug) return [];
    const data = await httpJson<RecruiteeList>(`https://${slug}.recruitee.com/api/offers/`);
    if (!Array.isArray(data?.offers)) return [];
    return parseRecruiteeOffers(data.offers, slug);
  }
}

/** the subdomain only (a pasted "x.recruitee.com" or URL works too). */
function recruiteeSlug(s: string | null | undefined): string | null {
  const slug = (s ?? "").trim().replace(/^https?:\/\//, "").split(/[./]/)[0]?.toLowerCase() ?? "";
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

/** Recruitee offers → RawPostings (pure; exported for fixture tests). */
export function parseRecruiteeOffers(offers: RecruiteeOffer[], slug: string): RawPosting[] {
  const out: RawPosting[] = [];
  const seen = new Set<number>();
  for (const o of offers) {
    if (!o?.id || !o.title?.trim() || seen.has(o.id)) continue;
    if (o.status && o.status !== "published") continue;
    seen.add(o.id);
    const places = (o.locations ?? [])
      .map((l) => [l.city, l.state, l.country].filter(Boolean).join(", ") || l.name || "")
      .filter(Boolean);
    const where = [...new Set(places.length ? places : [o.location ?? [o.city, o.country].filter(Boolean).join(", ")])].filter(Boolean).join("; ");
    const mode = o.remote ? "Remote - " : o.hybrid ? "Hybrid - " : "";
    const jd = [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join("\n\n");
    out.push({
      source: "recruitee",
      tier: "tier1",
      atsType: "recruitee",
      atsJobId: String(o.id),
      companyName: o.company_name?.trim() || slug,
      companySlug: slug,
      title: o.title.trim(),
      jdText: jd,
      jdHtml: [o.description, o.requirements].filter(Boolean).join("\n") || null,
      locationRaw: where ? `${mode}${where}` : o.remote ? "Remote" : null,
      applyUrl: o.careers_url ?? (o.slug ? `https://${slug}.recruitee.com/o/${o.slug}` : null),
      salaryRaw: recruiteeSalary(o.salary),
      postedAt: recruiteeDate(o.published_at ?? null),
      levelHint: RECRUITEE_LEVELS[o.experience_code ?? ""] ?? null,
      fetchedAt: new Date(),
      raw: { id: o.id, slug: o.slug, employment: o.employment_type_code, experience: o.experience_code } as Record<string, unknown>,
    });
  }
  return out;
}

/** "2026-11-03 20:08:14 UTC" → ISO. */
export function recruiteeDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function recruiteeSalary(s: RecruiteeOffer["salary"]): string | null {
  if (!s || !s.currency) return null;
  const lo = Number(s.min);
  const hi = Number(s.max);
  if (!(lo > 0) && !(hi > 0)) return null;
  const range = lo > 0 && hi > 0 ? `${lo} - ${hi}` : String(lo > 0 ? lo : hi);
  return `${s.currency} ${range}${s.period ? ` per ${s.period}` : ""}`;
}

/** Recruitee's experience buckets; "mid_level"/"experienced" are left to the title. */
const RECRUITEE_LEVELS: Record<string, LevelBand> = {
  student_college: "intern",
  entry_level: "junior",
  senior_level: "senior",
  manager: "manager",
  executive: "director",
};
