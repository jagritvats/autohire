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

export * from "./titles.js";
export * from "./skills.js";
export * from "./location.js";
export * from "./experience.js";
export * from "./salary.js";

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
  experience: ExperienceRange;
  applyUrl: string | null;
  dedupKey: string;
}

export function normalizePosting(raw: RawPosting): NormalizedPosting {
  const title = parseTitle(raw.title);
  const jd = raw.jdText || "";
  const skills = extractSkills(`${raw.title} ${jd}`);
  const requirements = parseRequirements(jd);
  const location = parseLocation(raw.locationRaw, jd);
  // deterministic YoE parse over title + JD (§11.2) — no per-job LLM.
  const experience = parseExperience(`${raw.title}\n${jd}`);

  // salary cascade step 1 — direct from JD/explicit field; else null band to fill later
  const salary: SalaryBand =
    extractSalaryFromText(raw.salaryRaw ?? "") ??
    extractSalaryFromText(jd) ??
    { min: null, max: null, currency: "USD", source: "none", confidence: "low" };

  const companyNameNorm = normCompany(raw.companyName);

  return {
    source: raw.source,
    tier: raw.tier,
    atsType: raw.atsType,
    atsJobId: raw.atsJobId,
    companyName: raw.companyName,
    companyNameNorm,
    companySlug: raw.companySlug,
    title: raw.title.trim(),
    titleNorm: title.titleNorm,
    roleArchetype: title.roleArchetype,
    levelBand: title.levelBand,
    jdText: jd,
    jdSkills: skills,
    requirements,
    location,
    salary,
    experience,
    applyUrl: raw.applyUrl,
    dedupKey: canonicalKey(companyNameNorm, title.titleNorm, location),
  };
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
