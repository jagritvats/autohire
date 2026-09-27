import type { Posting } from "../schema/entities.js";
import type { SourceKind } from "../schema/enums.js";
import { classifyLink } from "../normalize/links.js";
import { clamp } from "../util/vector.js";

/**
 * Source trust (§3, §11): how likely a listing is real, still open, and answered —
 * before looking at the listing itself. Priors come from a source-quality review
 * (2026-09): ATS boards are the company's system of record (a role disappears when it
 * closes) but still carry ghost/evergreen reqs (Greenhouse reports 18–22% ghost
 * postings); HN is first-party; Hirist/Cutshort have honest dates but some recruiter
 * reposts; Himalayas and Jobicy RE-DATE listings (40% of Himalayas jobs matched to
 * Greenhouse were >30 days older than shown). Coarse on purpose — per-listing
 * signals move them, and a source can't carry a listing on reputation alone.
 */
export const SOURCE_TRUST: Partial<Record<SourceKind, number>> = {
  greenhouse: 0.85,
  lever: 0.85,
  ashby: 0.85,
  workable: 0.85,
  smartrecruiters: 0.85,
  recruitee: 0.85,
  personio: 0.85,
  workday: 0.85,
  eightfold: 0.85,
  amazon: 0.85,
  oracle: 0.85,
  rippling: 0.85,
  jobvite: 0.85,
  atlassian: 0.85,
  keka: 0.85,
  zoho: 0.85,
  freshteam: 0.85,
  kula: 0.85,
  hn_whoishiring: 0.75,
  linkedin: 0.6,
  linkedin_guest: 0.6,
  yc: 0.6,
  hirist: 0.55,
  cutshort: 0.55,
  instahyre: 0.6,
  wellfound: 0.55,
  reddit: 0.55, // first-party posts, pay stated; thin volume
  timesjobs: 0.45, // IT-services heavy; its direct company links earn the ATS-link bonus
  remotive: 0.5,
  naukri: 0.45,
  adzuna: 0.4,
  arbeitnow: 0.4,
  himalayas: 0.35,
  remoteok: 0.35,
  jobicy: 0.25,
};
const DEFAULT_TRUST = 0.45;

/**
 * Sources whose "posted" date is when THEY ingested or re-stamped the job, not when the
 * employer published it — their recency can't be trusted, so freshness is capped (§3).
 */
export const REDATED_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>(["himalayas", "jobicy", "remoteok"]);

/** Evergreen / pipeline reqs that are never a specific open seat. */
export const EVERGREEN_TITLE_RE = /\b(talent (community|pool|network)|future opportunit|general application|expression of interest|evergreen|open application|join our talent)\w*/i;

/** Employer hidden behind a placeholder — typical of recruiter reposts. */
const HIDDEN_EMPLOYER_RE = /^(confidential|leading (mnc|company|product company)|top (mnc|product company|startup)|(a )?(reputed|well[- ]known|stealth) (company|startup|mnc)|stealth|undisclosed|unknown)$/i;

/** third-party recruiters posting "for a client" — slower, lower-signal pipelines. */
const CONSULTANCY_RE = /\b(on behalf of (our|a) client|our client is|for (one of )?our (esteemed |reputed )?clients?|staffing (agency|firm|solutions)|manpower|placement (agency|consultants?)|recruitment (agency|consultants?|partner)|hr consultancy|c2h|contract[- ]to[- ]hire|third[- ]party payroll)\b/i;

/** a poster whose NAME says it's an intermediary (common on Naukri / Hirist / Cutshort). */
/** (not a bare "consult…": Tata Consultancy Services / BCG are employers, not intermediaries) */
const CONSULTANCY_NAME_RE = /\b(staffing|manpower|placements?|placement consultants?|hr (solutions|services|consultancy|consultants)|recruitment|recruiters?|outsourcing|talent solutions)\b/i;

export interface TrustResult {
  score: number;
  flags: string[];
}

export function scoreSourceTrust(posting: Posting): TrustResult {
  const flags: string[] = [];
  let score = SOURCE_TRUST[posting.source] ?? DEFAULT_TRUST;

  // applying through the company's own ATS beats an aggregator's redirect chain
  if (posting.atsType === "unknown" && posting.applyUrl && classifyLink(posting.applyUrl).kind === "ats") score += 0.1;
  // a stated salary is a real-req signal (evergreen / fishing posts rarely commit to one)
  if (posting.salary.source === "jd_direct") score += 0.05;
  if (
    CONSULTANCY_RE.test(`${posting.companyName}\n${posting.jdText.slice(0, 3000)}`) ||
    CONSULTANCY_NAME_RE.test(posting.companyName)
  ) {
    score -= 0.2;
    flags.push("Posted by a staffing agency / consultancy — expect slower replies");
  }
  if (HIDDEN_EMPLOYER_RE.test(posting.companyName.trim())) {
    score -= 0.15;
    flags.push("Employer not named — verify who is actually hiring");
  }
  if (posting.repostCount >= 2) {
    score -= 0.1;
    flags.push(`Reposted ${posting.repostCount}× — possibly hard to fill or evergreen`);
  }
  if (posting.jdText.trim().length < 300) score -= 0.1; // thin JD: little to go on, often a re-host
  return { score: clamp(score), flags };
}
