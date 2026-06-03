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
  "remotive",
  "arbeitnow",
  "remoteok",
  "adzuna",
  "jobicy",
  "hn_whoishiring",
  "levelsfyi",
  "yc",
  // tier 2
  "linkedin_guest",
  // tier 3 (local agent only)
  "naukri",
  "ambitionbox",
  "glassdoor",
  "linkedin",
  // tier 4 (paid, optional)
  "serpapi",
  "apify",
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
