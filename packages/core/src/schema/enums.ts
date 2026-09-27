import { z } from "zod";

/**
 * Execution tier decides WHERE an adapter runs, not the source itself (§1).
 * The cloud only ever touches tier 1-2. Tier 3 runs exclusively on the
 * local agent (your own authenticated session). Tier 4 is paid/optional.
 */
export const ExecutionTier = z.enum(["tier1", "tier2", "tier3", "tier4"]);
export type ExecutionTier = z.infer<typeof ExecutionTier>;

/** Known ATS providers we have first-class pollers for. */
export const AtsType = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
  // big-employer careers backends (India engineering centres) — §§ India coverage
  "workday",
  "eightfold",
  "amazon",
  "oracle",
  "rippling",
  "jobvite",
  "atlassian",
  "jibe", // iCIMS Jibe career sites (PepsiCo, Keysight)
  "talentbrew", // Radancy TalentBrew career sites (UnitedHealth/Optum, Intuit)
  // India-market ATSes (Indian startups rarely use Greenhouse/Lever)
  "keka",
  "zoho",
  "freshteam",
  "kula",
  // LOCAL-AGENT-ONLY board: Cloudflare blocks non-browser clients, so there is no cloud
  // adapter — the agent polls it in the user's browser (invariant #1)
  "darwinbox",
  "unknown",
]);
export type AtsType = z.infer<typeof AtsType>;

/** Every adapter is tagged with the source it speaks for. */
export const SourceKind = z.enum([
  // tier 1
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
  "workday",
  "eightfold",
  "amazon",
  "oracle",
  "rippling",
  "jobvite",
  "atlassian",
  "jibe",
  "talentbrew",
  "keka",
  "zoho",
  "freshteam",
  "kula",
  "remotive",
  "arbeitnow",
  "remoteok",
  "adzuna",
  "jobicy",
  "hn_whoishiring",
  "levelsfyi",
  "yc",
  "himalayas",
  "careerjet",
  // tier 2
  "linkedin_guest",
  "hirist",
  "cutshort",
  "timesjobs",
  "instahyre",
  "wellfound",
  "reddit",
  // tier 3 (local agent only)
  "naukri",
  "ambitionbox",
  "glassdoor",
  "linkedin",
  "darwinbox", // board ATS (Rapido/Porter/Upstox…) — the agent's local_board_poll
  "peerlist", // discovery feed
  // a page you captured with the browser extension that isn't on a known board
  "capture",
  // tier 4 (paid, optional)
  "serpapi",
  "apify",
  "jsearch", // paid + key-gated; its adapter runs as tier2 (a cloud-safe API) so feeds can use it
]);
export type SourceKind = z.infer<typeof SourceKind>;

/** Normalized seniority band parsed from title + JD (§11.2). */
export const LevelBand = z.enum([
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "lead",
  "principal",
  "manager",
  "director",
]);
export type LevelBand = z.infer<typeof LevelBand>;

export const LevelBandOrder: Record<z.infer<typeof LevelBand>, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  staff: 4,
  lead: 4,
  principal: 5,
  manager: 5,
  director: 6,
};

/** Work mode parsed from a posting (§11.3). */
export const LocationMode = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type LocationMode = z.infer<typeof LocationMode>;

/**
 * Posting lifecycle (§3). A single global status alongside the `isActive` freshness
 * flag: `active` shows in the feed; `invalidated` = manually judged bad (spam/dupe/
 * fake, reversible); `stale` = disappeared from the ATS (soft-deleted by markStale).
 * Per-user hide (archive) and bookmark are NOT here — they're a tenant-scoped overlay.
 */
export const PostingStatus = z.enum(["active", "invalidated", "stale"]);
export type PostingStatus = z.infer<typeof PostingStatus>;

/**
 * Geo-restriction tag for "remote" roles — the false-positive minefield (§11.3).
 * A `us_only` remote role gets down-weighted hard, not surfaced as a clean match.
 */
export const RemoteGeo = z.enum([
  "worldwide",
  "india_ok",
  "apac_ok",
  "us_only",
  "eu_only",
  "us_eu",
  "unknown",
]);
export type RemoteGeo = z.infer<typeof RemoteGeo>;

/** A requirement parsed from a JD is one of these — must-have gates harder. */
export const RequirementStrength = z.enum(["must_have", "nice_to_have", "transferable"]);
export type RequirementStrength = z.infer<typeof RequirementStrength>;

export const SalaryConfidence = z.enum(["high", "medium_high", "medium", "low"]);
export type SalaryConfidence = z.infer<typeof SalaryConfidence>;

export const ApplicationStatus = z.enum([
  "saved",
  "drafting",
  "ready",
  "applied",
  "screening",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

/** Command-plane job types. `runtime` decides which plane drains it (§ control plane). */
export const JobType = z.enum([
  "discover", // resolve seed/new companies → ATS boards
  "poll", // poll registered ATS boards due for poll
  "rank", // recompute matches for the tenant
  "enrich_t1", // Tier-1 enrichment (Adzuna / levels.fyi) — cloud
  "recheck", // re-poll a set of postings via Tier 1-2 adapters (freshness/staleness) — cloud
  "purge", // bulk soft/hard-remove postings older than a threshold — cloud
  "liveness", // re-probe the top cards' own job pages between polls (dead-link check) — cloud
  "tier3_poll", // Naukri/Glassdoor/etc — LOCAL agent only
  "enrich_t3", // ratings/India comp — LOCAL agent only
  "form_fill", // Playwright fill to review gate — LOCAL agent only
  "import_yc", // import your YC/Work-at-a-Startup profile — LOCAL agent only (auth-gated)
  "local_board_poll", // poll boards with no cloud adapter (Darwinbox) in your browser — LOCAL agent only
]);
export type JobType = z.infer<typeof JobType>;

export const JobRuntime = z.enum(["cloud", "local"]);
export type JobRuntime = z.infer<typeof JobRuntime>;

export const JobStatus = z.enum(["queued", "running", "done", "error", "canceled"]);
export type JobStatus = z.infer<typeof JobStatus>;

/** which plane a job type runs on — the tier boundary, encoded (invariant #1). */
export const JOB_RUNTIME: Record<z.infer<typeof JobType>, z.infer<typeof JobRuntime>> = {
  discover: "cloud",
  poll: "cloud",
  rank: "cloud",
  enrich_t1: "cloud",
  recheck: "cloud",
  purge: "cloud",
  liveness: "cloud",
  tier3_poll: "local",
  enrich_t3: "local",
  form_fill: "local",
  import_yc: "local",
  local_board_poll: "local",
};

export const RoleArchetype = z.enum([
  "backend",
  "platform",
  "fullstack",
  "infra_devops",
  "data_ml",
  "frontend",
  "mobile",
  "sre",
  "other",
]);
export type RoleArchetype = z.infer<typeof RoleArchetype>;
