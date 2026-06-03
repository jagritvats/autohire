import type { AtsType } from "@jobflow/core";
import { slugify } from "@jobflow/core";
import { httpJson } from "../types.js";

/**
 * ATS Detector (§ ATS Detector). Given a careers URL and/or company name, identify
 * which ATS hosts their board and extract the slug. This is the linchpin of
 * discovery: aggregators/HN/YC give company NAMES → we resolve to a board → poll
 * the ATS directly for the good data.
 *
 * Two strategies, in order:
 *   1. URL pattern extraction (when we have a careers URL)
 *   2. Slug probing — guess the slug from the name and confirm via a live API hit
 */

export interface DetectResult {
  atsType: AtsType;
  atsSlug: string | null;
  confidence: "confirmed" | "guessed" | "none";
}

// host → ats, with a capture for the slug
const URL_PATTERNS: Array<{ ats: AtsType; re: RegExp; group: number }> = [
  { ats: "greenhouse", re: /boards\.greenhouse\.io\/([^/?#]+)/i, group: 1 },
  { ats: "greenhouse", re: /job-boards\.greenhouse\.io\/([^/?#]+)/i, group: 1 },
  { ats: "greenhouse", re: /greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/i, group: 1 },
  { ats: "lever", re: /jobs\.lever\.co\/([^/?#]+)/i, group: 1 },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([^/?#]+)/i, group: 1 },
  { ats: "ashby", re: /ashbyhq\.com\/([^/?#]+)/i, group: 1 },
  { ats: "workable", re: /([^./]+)\.workable\.com/i, group: 1 },
  { ats: "workable", re: /apply\.workable\.com\/([^/?#]+)/i, group: 1 },
  { ats: "recruitee", re: /([^./]+)\.recruitee\.com/i, group: 1 },
  { ats: "personio", re: /([^./]+)\.jobs\.personio\.(?:de|com)/i, group: 1 },
  { ats: "smartrecruiters", re: /careers\.smartrecruiters\.com\/([^/?#]+)/i, group: 1 },
];

/** Confirm a (ats, slug) pair actually returns jobs — turns a guess into confirmed. */
async function probe(ats: AtsType, slug: string): Promise<boolean> {
  switch (ats) {
    case "greenhouse": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    case "lever": {
      const r = await httpJson<unknown[]>(
        `https://api.lever.co/v0/postings/${slug.toLowerCase()}?mode=json&limit=1`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r);
    }
    case "ashby": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    case "workable": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=false`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    default:
      return false;
  }
}

/** Extract ats+slug from a careers URL via pattern, then confirm it. */
export async function detectFromUrl(url: string): Promise<DetectResult> {
  for (const { ats, re, group } of URL_PATTERNS) {
    const m = url.match(re);
    if (m?.[group]) {
      const slug = m[group]!;
      const ok = await probe(ats, slug).catch(() => false);
      return { atsType: ats, atsSlug: slug, confidence: ok ? "confirmed" : "guessed" };
    }
  }
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}

/**
 * When we only have a company name (the common case from aggregators/HN), generate
 * candidate slugs and probe the big three ATSes. First confirmed hit wins.
 */
export async function detectFromName(companyName: string): Promise<DetectResult> {
  const candidates = slugCandidates(companyName);
  // probe greenhouse → ashby → lever (richness order), candidates in order
  const order: AtsType[] = ["greenhouse", "ashby", "lever"];
  for (const slug of candidates) {
    for (const ats of order) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probe(ats, slug).catch(() => false);
      if (ok) return { atsType: ats, atsSlug: slug, confidence: "confirmed" };
    }
  }
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}

export function slugCandidates(name: string): string[] {
  const base = slugify(name);
  const compact = base.replace(/-/g, "");
  const noInc = base.replace(/-?(inc|llc|ltd|technologies|labs|hq)$/g, "");
  return [...new Set([base, compact, noInc, noInc.replace(/-/g, "")])].filter(Boolean);
}

export async function detect(input: { url?: string | null; name?: string }): Promise<DetectResult> {
  if (input.url) {
    const byUrl = await detectFromUrl(input.url);
    if (byUrl.atsType !== "unknown") return byUrl;
  }
  if (input.name) return detectFromName(input.name);
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}
