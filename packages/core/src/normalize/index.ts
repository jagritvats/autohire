import type { RawPosting } from "../schema/entities.js";
import type {
  LevelBand,
  RoleArchetype,
  SourceKind,
  AtsType,
  ExecutionTier,
} from "../schema/enums.js";
import type { ExperienceRange, ParsedLocation, Requirement, SalaryBand } from "../schema/entities.js";
import { normCompany, parseTitle, slugify } from "./titles.js";
import { extractSkills, parseRequirements } from "./skills.js";
import { parseLocation } from "./location.js";
import { parseExperience } from "./experience.js";
import { extractSalaryFromText } from "./salary.js";
import { currencyHintFor } from "../salary/market.js";

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
  salary: SalaryBand;
  /** the source's own salary text, kept for exact re-parsing */
  salaryRaw: string | null;
  experience: ExperienceRange;
  applyUrl: string | null;
  /** source publish date (ISO), sanity-checked; null when absent/untrustworthy (§3). */
  postedAt: string | null;
  /** the source flagged the poster as a consultancy / staffing intermediary. */
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
    salary,
    salaryRaw: raw.salaryRaw ?? null,
    experience,
    applyUrl: raw.applyUrl,
    postedAt: parsePostedAt(raw.postedAt),
    postedByAgency: raw.postedByAgency ?? false,
    dedupKey: canonicalKey(companyNameNorm, title.titleNorm, location),
  };
}

/**
 * Salary cascade step 1 (§11.4): what the posting states — the source's own salary field
 * first, then the JD. The location prices a bare "$" and an unlabeled salary field. No
 * stated pay → an empty band; the estimator fills `salaryEstimate` separately.
 */
export function parseStatedSalary(salaryRaw: string | null, jdText: string, location: ParsedLocation): SalaryBand {
  const currencyHint = currencyHintFor(location);
  return (
    extractSalaryFromText(salaryRaw ?? "", { structured: true, currencyHint }) ??
    extractSalaryFromText(jdText, { currencyHint }) ?? {
      min: null,
      max: null,
      currency: currencyHint ?? "USD",
      source: "none",
      confidence: "low",
    }
  );
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
 * Stage-1 dedup key (§ Deduper): cheap exact hash of normalized
 * company + title + coarse location. Stage-2 (embedding cosine) lives in the
 * deduper for near-collisions this key misses.
 */
export function canonicalKey(
  companyNameNorm: string,
  titleNorm: string,
  loc: ParsedLocation,
): string {
  const locKey =
    loc.mode === "remote"
      ? `remote:${loc.remoteGeo}`
      : `${loc.mode}:${slugify(loc.city ?? loc.country ?? "na")}`;
  return `${companyNameNorm}|${titleNorm}|${locKey}`;
}
