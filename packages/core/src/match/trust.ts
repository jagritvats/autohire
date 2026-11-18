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
  teamtailor: 0.85, // the employer's own career site (public RSS)
  bamboohr: 0.85, // the employer's own careers page; datePosted is the opening's own
  breezy: 0.85, // the employer's own portal; published_date is the position's
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
  darwinbox: 0.85, // the employer's own ATS (local agent); posted_on is a real publish date
  jibe: 0.85, // the employer's own career site, fed by its ATS (iCIMS)
  talentbrew: 0.85, // the employer's own career site, fed by its ATS (Taleo/Avature)
  hn_whoishiring: 0.75,
  linkedin: 0.6,
  linkedin_guest: 0.6,
  yc: 0.6,
  hirist: 0.55,
  cutshort: 0.55,
  instahyre: 0.6,
  wellfound: 0.55,
  peerlist: 0.5, // startups posting directly + big-company roles it re-lists
  reddit: 0.55, // first-party posts, pay stated; thin volume
  timesjobs: 0.45, // IT-services heavy; its direct company links earn the ATS-link bonus
  remotive: 0.5,
  naukri: 0.45,
  adzuna: 0.4, // its date is when Adzuna placed the ad; apply goes through an Adzuna hop
  jsearch: 0.4, // Google-for-Jobs index: LinkedIn/Naukri reposts, relative dates
  careerjet: 0.35, // crawled fragments behind a tracking redirect
  arbeitnow: 0.4,
  himalayas: 0.35,
  remoteok: 0.35,
  jobicy: 0.25,
  // user-configured feeds: unknown provenance — neutral prior, the listing must earn more
  rss: 0.45,
  json_feed: 0.45,
};
const DEFAULT_TRUST = 0.45;

/**
 * Sources whose "posted" date is when THEY ingested or re-stamped the job, not when the
 * employer published it — their recency can't be trusted, so freshness is capped (§3).
 */
export const REDATED_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "himalayas",
  "jobicy",
  "remoteok",
  "adzuna",
  "careerjet",
  "jsearch",
  // a feed's item date is when the FEED published it (often a re-post), not the employer
  "rss",
  "json_feed",
]);

/** Evergreen / pipeline reqs that are never a specific open seat. */
export const EVERGREEN_TITLE_RE = /\b(talent (community|pool|network)|future opportunit|general application|expression of interest|evergreen|open application|join our talent)\w*/i;

/** Employer hidden behind a placeholder — typical of recruiter reposts. */
const HIDDEN_EMPLOYER_RE = /^(confidential|leading (mnc|company|product company)|top (mnc|product company|startup)|(a )?(reputed|well[- ]known|stealth) (company|startup|mnc)|stealth|undisclosed|unknown)$/i;

/** third-party recruiters posting "for a client" — slower, lower-signal pipelines. */
const CONSULTANCY_RE = /\b(on behalf of (our|a) client|our client is|for (one of )?our (esteemed |reputed )?clients?|staffing (agency|firm|solutions)|manpower|placement (agency|consultants?)|recruitment (agency|consultants?|partner)|hr consultancy|c2h|contract[- ]to[- ]hire|third[- ]party payroll)\b/i;

/** a poster whose NAME says it's an intermediary (common on Naukri / Hirist / Cutshort). */
/** (not a bare "consult…": Tata Consultancy Services / BCG are employers, not intermediaries) */
const CONSULTANCY_NAME_RE = /\b(staffing|manpower|placements?|placement consultants?|hr (solutions|services|consultancy|consultants)|recruitment|recruiters?|outsourcing|talent solutions)\b/i;

/**
 * AI-training marketplaces (2026-09): hourly contracts writing / rating data for AI labs,
 * posted as "Software Engineer — Fully Remote | $50/hr". Himalayas lists them as
 * mid-level engineering jobs. Matched on the company name (the known brands) or on the JD
 * (new brands use the same pitch: evaluate model output, for AI labs, paid by the hour).
 */
const AI_GIG_PLATFORM_RE = /^(mercor|micro1|outlier( ai)?|alignerr|data ?annotation( tech)?|remotasks|crossing hurdles|turing ai trainer|handshake ai)\b/i;
const AI_GIG_WORK_RE = /\b(evaluat\w*|review\w*|rat(e|ing)|rank\w*|grad(e|ing)|compar\w*|critiqu\w*)\b[^.]{0,60}\b(model[- ]generated|model outputs?|model responses?|ai[- ]generated|llm (outputs?|responses?)|ai responses?|frontier models?)\b|\b(ai (tutor|trainer)s?|rlhf|train(ing)? (frontier|large language|ai|llm) models?)\b/i;
/** paid like a gig — engineers at AI companies also "evaluate model outputs", on a salary */
const AI_GIG_TERMS_RE = /(\bper hour\b|\/\s?(hr|hour)\b|\bhourly (rate|pay)\b|\btype: contract\b|\bfreelance\b|\bproject[- ]based\b|\bflexible hours\b)/i;

/** "no immediate opening — send your CV for future consideration": a talent pool, not a seat */
export const TALENT_POOL_JD_RE = /\b(may not be an immediate opening|no immediate (opening|vacanc)\w*|not (currently )?hiring for (a|any) specific (role|position)|submit your (resume|cv) for future (consideration|opportunities))\b/i;

export interface TrustResult {
  score: number;
  flags: string[];
  /**
   * An AI-training gig, not an engineering seat. The scorer treats it like a non-target
   * archetype (feasibility dampener) — trust alone is too small a weight to move it.
   */
  aiTrainingGig: boolean;
}

export function isAiTrainingGig(posting: Pick<Posting, "companyName" | "jdText">): boolean {
  if (AI_GIG_PLATFORM_RE.test(posting.companyName.trim())) return true;
  const jd = posting.jdText.slice(0, 4000);
  return AI_GIG_WORK_RE.test(jd) && AI_GIG_TERMS_RE.test(jd);
}

export function scoreSourceTrust(posting: Posting): TrustResult {
  const flags: string[] = [];
  let score = SOURCE_TRUST[posting.source] ?? DEFAULT_TRUST;

  // applying through the company's own ATS beats an aggregator's redirect chain
  if (posting.atsType === "unknown" && posting.applyUrl && classifyLink(posting.applyUrl).kind === "ats") score += 0.1;
  // a stated salary is a real-req signal (evergreen / fishing posts rarely commit to one)
  if (posting.salary.source === "jd_direct") score += 0.05;
  if (
    posting.postedByAgency ||
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
  const aiTrainingGig = isAiTrainingGig(posting);
  if (aiTrainingGig) {
    score -= 0.4;
    flags.unshift("AI-training gig (hourly contract rating/writing data for AI labs) — not an engineering seat");
  }
  return { score: clamp(score), flags, aiTrainingGig };
}
