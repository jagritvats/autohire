export * from "./types.js";
export * from "./registry.js";
export * from "./detector/index.js";
export { GreenhouseAdapter } from "./ats/greenhouse.js";
export { LeverAdapter } from "./ats/lever.js";
export { AshbyAdapter } from "./ats/ashby.js";
export { WorkableAdapter } from "./ats/workable.js";
export { RemotiveAdapter } from "./aggregators/remotive.js";
export { ArbeitnowAdapter } from "./aggregators/arbeitnow.js";
export { HnWhoIsHiringAdapter } from "./hn/whoishiring.js";
// Tier-1 enrichment (§11.4) — comp cascade, cloud-safe.
export {
  fetchLevelsComp,
  parseLevelsMarkdown,
  familyMedianFor,
  slugFromName,
  LEVELS_ATTRIBUTION,
  type LevelsComp,
} from "./enrich/levelsfyi.js";
export { fetchAdzunaSalary, hasAdzunaKeys, type AdzunaSalary } from "./enrich/adzuna.js";
// Tier 3 — local agent only; deliberately NOT in the cloud `ADAPTERS` registry.
export {
  NaukriAdapter,
  LinkedInAdapter,
  AmbitionBoxEnricher,
  GlassdoorEnricher,
  Tier3DisabledError,
  type Tier3Context,
} from "./tier3/index.js";
// Tier-3 India-SWE poll targeting (pure config; used by the local agent's poll planner).
export {
  INDIA_TECH_HUBS,
  INDIA_SWE_QUERIES,
  buildIndiaSweTargets,
  lpaFloorFromInr,
  type Tier3PollTarget,
  type Tier3PollOptions,
} from "./tier3/targets.js";
