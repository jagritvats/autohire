import type { RawPosting } from "../schema/entities.js";
import type {
  LevelBand,
  RoleArchetype,
  SourceKind,
  AtsType,
  ExecutionTier,
} from "../schema/enums.js";
import type { ExperienceRange, ParsedLocation, Requirement, SalaryBand } from "../schema/entities.js";
import { dedupTitleKey, normCompany, parseTitle, slugify } from "./titles.js";
import { extractSkills, parseRequirements } from "./skills.js";
import { locationCountryCodes, parseLocation } from "./location.js";
import { parseExperience } from "./experience.js";
import { extractSalaryFromText } from "./salary.js";
import { currencyHintFor } from "../salary/market.js";
import { looksLikeAgency } from "../match/trust.js";

export * from "./titles.js";
export * from "./skills.js";
export * from "./location.js";
export * from "./experience.js";
export * from "./salary.js";
export * from "./links.js";
export * from "./chat.js";
export * from "./reposts.js";
export * from "./jd.js";

/**
 * The canonical fields derived from a RawPosting. The persistence layer combines
 * this with ids / timestamps to produce a full `Posting` (§5). Keeping normalize a
 * pure function means it's trivially unit-testable and runs identically in the
 * cloud worker, the CLI, and the extension.
 */
export interface NormalizedPosting {
  source: SourceKind;
  tier: ExecutionTier;
  atsType: AtsType;
  atsJobId: string;
  companyName: string;
  companyNameNorm: string;
  companySlug: string | null;
  title: string;
  titleNorm: string;
  roleArchetype: RoleArchetype;
  levelBand: LevelBand | null;
  jdText: string;
  jdSkills: string[];
  requirements: Requirement[];
  location: ParsedLocation;
  /** the source's own location text, kept for exact re-parsing (`renormalizePostings`) */
  locationRaw: string | null;
  salary: SalaryBand;
  /** the source's own salary text, kept for exact re-parsing */
  salaryRaw: string | null;
  experience: ExperienceRange;
  applyUrl: string | null;
  /** source publish date (ISO), sanity-checked; null when absent/untrustworthy (§3). */
  postedAt: string | null;
  /**
   * The poster is a consultancy / staffing intermediary: the source's own flag when it has
   * one (Naukri), else `looksLikeAgency` on the company name + JD (every other source). A
   * trust signal + flag in scoring, never a filter (invariant #4).
   */
  postedByAgency: boolean;
  dedupKey: string;
}

export function normalizePosting(raw: RawPosting): NormalizedPosting {
  const title = parseTitle(raw.title);
  const jd = raw.jdText || "";
  const skills = extractSkills(`${raw.title} ${jd}`);
  const requirements = parseRequirements(jd);
  const location = parseLocation(raw.locationRaw, jd);
  // the source's structured range when it has one; else a deterministic parse of
  // title + JD (§11.2) — no per-job LLM.
  const hint = raw.experienceHint;
  const experience =
    hint && (hint.min != null || hint.max != null)
      ? { min: hint.min ?? null, max: hint.max ?? null }
      : parseExperience(`${raw.title}\n${jd}`);

  const salary = parseStatedSalary(raw.salaryRaw ?? null, jd, location);

  const companyNameNorm = normCompany(raw.companyName);

  return {
    source: raw.source,
    tier: raw.tier,
    atsType: raw.atsType,
    atsJobId: scopedJobId(raw),
    companyName: raw.companyName,
    companyNameNorm,
    companySlug: raw.companySlug,
    title: raw.title.trim(),
    titleNorm: title.titleNorm,
    roleArchetype: title.roleArchetype,
    levelBand: title.levelBand ?? raw.levelHint ?? null, // title wins; the source's bucket fills a gap
    jdText: jd,
    jdSkills: skills,
    requirements,
    location,
    locationRaw: raw.locationRaw?.trim() || null,
    salary,
    salaryRaw: raw.salaryRaw ?? null,
    experience,
    applyUrl: raw.applyUrl,
    postedAt: parsePostedAt(raw.postedAt),
    // the source's own answer wins (Naukri's flag, even a "no"); else read it ourselves
    postedByAgency: raw.postedByAgency ?? looksLikeAgency({ companyName: raw.companyName, jdText: jd }),
    dedupKey: canonicalKey(companyNameNorm, dedupTitleKey(raw.title), location),
  };
}

/**
 * Salary cascade step 1 (§11.4): what the posting states — the source's own salary field
 * first, then the JD. The location prices a bare "$" and an unlabeled salary field. No
 * stated pay → an empty band; the estimator fills `salaryEstimate` separately.
 */
export function parseStatedSalary(salaryRaw: string | null, jdText: string, location: ParsedLocation): SalaryBand {
  const currencyHint = currencyHintFor(location);
  const country = salaryCountryOf(location);
  return (
    extractSalaryFromText(salaryRaw ?? "", { structured: true, currencyHint, country }) ??
    extractSalaryFromText(jdText, { currencyHint, country }) ?? {
      min: null,
      max: null,
      currency: currencyHint ?? "USD",
      source: "none",
      confidence: "low",
    }
  );
}

/**
 * The country whose currency a bare "$" / "kr" / "¥" in this posting is read in: its
 * primary place, else the country a remote restriction names (US-only remote → US).
 * null = unknown, so a "$" stays USD but at reduced confidence.
 */
function salaryCountryOf(location: ParsedLocation): string | null {
  const primary = locationCountryCodes(location)[0];
  if (primary) return primary;
  if (location.mode === "remote" && (location.remoteGeo === "us_only" || location.remoteGeo === "us_eu")) return "US";
  if (location.mode === "remote" && location.remoteGeo === "india_ok") return "IN";
  return null;
}

/**
 * Postings key on (atsType, atsJobId) (invariant #5). Every non-ATS source shares
 * atsType "unknown", so a Remotive id and an HN id that happen to be equal would
 * overwrite each other — prefix the source to keep the key unique per source.
 */
export function scopedJobId(raw: Pick<RawPosting, "atsType" | "source" | "atsJobId">): string {
  if (raw.atsType !== "unknown") return raw.atsJobId;
  const prefix = `${raw.source}:`;
  return raw.atsJobId.startsWith(prefix) ? raw.atsJobId : `${prefix}${raw.atsJobId}`;
}

/** A publish date we can trust: parseable, not in the future, not before 2000. */
export function parsePostedAt(v: RawPosting["postedAt"] | undefined): string | null {
  if (v == null || v === "") return null;
  const t = new Date(v as string | Date).getTime();
  if (!Number.isFinite(t)) return null;
  if (t > Date.now() + 86_400_000 || t < Date.UTC(2000, 0, 1)) return null;
  return new Date(t).toISOString();
}

/**
 * Stage-1 dedup key (§ Deduper): cheap exact hash of normalized company + the role's
 * dedup title key (`dedupTitleKey` — team, specialty and level kept) + coarse location.
 * Stage 2 (cross-source near-collisions the key misses) lives in the deduper.
 */
export function canonicalKey(
  companyNameNorm: string,
  titleKey: string,
  loc: ParsedLocation,
): string {
  const locKey =
    loc.mode === "remote"
      ? `remote:${loc.remoteGeo}`
      : `${loc.mode}:${cityKey(loc.city ?? loc.country ?? "na")}`;
  return `${companyNameNorm}|${titleKey}|${locKey}`;
}

/** The dedup key computed from a stored posting (a stored key may predate a key change). */
export function postingDedupKey(p: { companyName: string; title: string; location: ParsedLocation }): string {
  return canonicalKey(normCompany(p.companyName), dedupTitleKey(p.title), p.location);
}

/** one spelling per city, so "Bangalore" on an aggregator and "Bengaluru" on a board key alike. */
const CITY_ALIASES: Readonly<Record<string, string>> = {
  bangalore: "bengaluru",
  "bangalore-urban": "bengaluru",
  gurgaon: "gurugram",
  bombay: "mumbai",
  "new-delhi": "delhi",
  "delhi-ncr": "delhi",
  madras: "chennai",
  calcutta: "kolkata",
  nyc: "new-york",
  "new-york-city": "new-york",
  sf: "san-francisco",
  "bay-area": "san-francisco",
  "sf-bay-area": "san-francisco",
};

export function cityKey(city: string): string {
  const s = slugify(city);
  return CITY_ALIASES[s] ?? s;
}
