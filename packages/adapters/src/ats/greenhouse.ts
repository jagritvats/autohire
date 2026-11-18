import { countryCodeFromText, type RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Greenhouse board API (Tier 1, free, no auth). Richest free source — full JD +
 * structured fields. Verified live:
 *   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 */

interface GhJob {
  id: number;
  internal_job_id?: number;
  title: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  /** with ?content=true: the req's offices; `location` is the full "City, Region, Country" */
  offices?: GhOffice[];
  content?: string; // HTML, only with ?content=true
  company_name?: string;
  metadata?: unknown;
}
export interface GhOffice {
  id?: number;
  name?: string;
  location?: string | null;
}
interface GhResponse {
  jobs: GhJob[];
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly source = "greenhouse" as const;
  readonly tier = "tier1" as const;

  /** per-job endpoint: 404 "Job not found" once the req is closed (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.slug) return null;
    return liveFromStatus(await httpStatus(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.slug)}/jobs/${encodeURIComponent(job.jobId)}`));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    const data = await httpJson<GhResponse>(url);
    if (!data?.jobs) return [];

    const jobs = target.limit ? data.jobs.slice(0, target.limit) : data.jobs;
    return jobs.map((j) => {
      const jdText = htmlToText(j.content);
      return {
        source: "greenhouse",
        tier: "tier1",
        atsType: "greenhouse",
        atsJobId: String(j.id),
        companyName: j.company_name ?? slug,
        companySlug: slug,
        title: j.title,
        jdText,
        jdHtml: j.content ?? null,
        locationRaw: greenhouseLocation(j.location?.name, j.offices),
        applyUrl: j.absolute_url ?? null,
        salaryRaw: null,
        // updated_at is bulk-bumped on board edits (every Stripe req shared one timestamp),
        // which faked recency — only first_published is a publish date (§3).
        postedAt: j.first_published ?? null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}

/** a location that is only a work mode: "Hybrid", "In-Office", "Distributed; Hybrid"… */
const MODE_WORD = /^(hybrid|in[- ]?office|office[- ]based|on[- ]?site|onsite|distributed|remote|flexible|anywhere)$/i;

/**
 * Some boards (Cloudflare: 476 of 483 roles, 2026-11) put the WORK MODE in `location.name`
 * and the places in `offices[]`. Read the offices then, so the role counts in its markets,
 * and keep the mode as a prefix the location parser understands ("Hybrid - Austin, TX…").
 * A real place in `location.name` is kept as it is.
 */
export function greenhouseLocation(name: string | undefined, offices: GhOffice[] | undefined): string | null {
  const raw = name?.trim() || null;
  if (!raw) return officePlaces(offices);
  const modes = raw.split(/\s*[;,/|]\s*/).filter(Boolean);
  if (!modes.every((m) => MODE_WORD.test(m))) return raw;
  // a bare "Remote" stays as it is: its office is often just the HQ, and reading it as
  // "Remote - San Francisco" would narrow a role that may be open anywhere
  if (modes.every((m) => /^(remote|anywhere)$/i.test(m))) return raw;
  const places = officePlaces(offices);
  if (!places) return raw;
  const has = (re: RegExp) => modes.some((m) => re.test(m));
  // a mixed "Distributed; Hybrid" reads as hybrid: claiming fully remote would overreach
  const prefix = has(/hybrid|flexible/i) ? "Hybrid - " : has(/distributed|remote|anywhere/i) ? "Remote - " : "";
  return `${prefix}${places}`;
}

/**
 * Each office's label: its short `name` when that already places it in a country ("London,
 * United Kingdom", "Remote India", "Austin, TX"), else the full `location` ("AMER" →
 * "United States", "Remote Sweden" stays).
 */
function officePlaces(offices: GhOffice[] | undefined): string | null {
  const labels = new Set<string>();
  for (const o of offices ?? []) {
    const short = o.name?.trim();
    const full = o.location?.trim();
    const label = short && (countryCodeFromText(short) || !full) ? short : full || short;
    if (label) labels.add(label);
  }
  return labels.size ? [...labels].join("; ") : null;
}
