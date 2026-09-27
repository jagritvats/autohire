export * from "./types.js";
export * from "./registry.js";
export * from "./detector/index.js";
export { GreenhouseAdapter } from "./ats/greenhouse.js";
export { LeverAdapter } from "./ats/lever.js";
export { AshbyAdapter } from "./ats/ashby.js";
export { WorkableAdapter } from "./ats/workable.js";
export { SmartRecruitersAdapter } from "./ats/smartrecruiters.js";
export { WorkdayAdapter, findCountryFacet, relativePosted, parseWorkdaySlug } from "./ats/workday.js";
export { EightfoldAdapter } from "./ats/eightfold.js";
export { AmazonJobsAdapter } from "./ats/amazon.js";
export { OracleHcmAdapter } from "./ats/oracle.js";
export { RipplingAdapter } from "./ats/rippling.js";
export { JobviteAdapter, parseJobviteXml } from "./ats/jobvite.js";
export { AtlassianAdapter } from "./ats/atlassian.js";
export { KekaAdapter } from "./ats/keka.js";
export { ZohoRecruitAdapter } from "./ats/zoho.js";
export { FreshteamAdapter } from "./ats/freshteam.js";
export { KulaAdapter } from "./ats/kula.js";
export { HimalayasAdapter } from "./aggregators/himalayas.js";
export { HiristAdapter } from "./india/hirist.js";
export { CutshortAdapter, parseCutshortPage } from "./india/cutshort.js";
export { TimesJobsAdapter } from "./india/timesjobs.js";
export { InstahyreAdapter } from "./india/instahyre.js";
export { WellfoundAdapter, parseWellfoundPage } from "./india/wellfound.js";
export { RedditHiringAdapter, findMegathread, parseHiringThread } from "./india/reddit.js";
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
// Community channels (Telegram public previews) — discovery via links, never trusted as postings.
export { fetchTelegramChannel, parseTelegramPreview, type TelegramFetchOptions } from "./community/telegram.js";
