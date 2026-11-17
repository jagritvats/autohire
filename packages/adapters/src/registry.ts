import type { AtsType, SourceKind } from "@jobflow/core";
import type { SourceAdapter } from "./types.js";
import { GreenhouseAdapter } from "./ats/greenhouse.js";
import { LeverAdapter } from "./ats/lever.js";
import { AshbyAdapter } from "./ats/ashby.js";
import { WorkableAdapter } from "./ats/workable.js";
import { SmartRecruitersAdapter } from "./ats/smartrecruiters.js";
import { WorkdayAdapter } from "./ats/workday.js";
import { EightfoldAdapter } from "./ats/eightfold.js";
import { AmazonJobsAdapter } from "./ats/amazon.js";
import { OracleHcmAdapter } from "./ats/oracle.js";
import { RipplingAdapter } from "./ats/rippling.js";
import { JobviteAdapter } from "./ats/jobvite.js";
import { AtlassianAdapter } from "./ats/atlassian.js";
import { JibeAdapter } from "./ats/jibe.js";
import { TalentBrewAdapter } from "./ats/talentbrew.js";
import { KekaAdapter } from "./ats/keka.js";
import { ZohoRecruitAdapter } from "./ats/zoho.js";
import { FreshteamAdapter } from "./ats/freshteam.js";
import { KulaAdapter } from "./ats/kula.js";
import { HimalayasAdapter } from "./aggregators/himalayas.js";
import { HiristAdapter } from "./india/hirist.js";
import { CutshortAdapter } from "./india/cutshort.js";
import { TimesJobsAdapter } from "./india/timesjobs.js";
import { InstahyreAdapter } from "./india/instahyre.js";
import { WellfoundAdapter } from "./india/wellfound.js";
import { RedditHiringAdapter } from "./india/reddit.js";
import { RemotiveAdapter } from "./aggregators/remotive.js";
import { ArbeitnowAdapter } from "./aggregators/arbeitnow.js";
import { AdzunaSearchAdapter } from "./aggregators/adzuna.js";
import { CareerjetAdapter } from "./aggregators/careerjet.js";
import { JSearchAdapter } from "./aggregators/jsearch.js";
import { HnWhoIsHiringAdapter } from "./hn/whoishiring.js";
import { RssFeedAdapter } from "./feeds/rss.js";
import { JsonFeedAdapter } from "./feeds/jsonfeed.js";

/** Singleton adapters keyed by source. Add a source = register one line here. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  lever: new LeverAdapter(),
  ashby: new AshbyAdapter(),
  workable: new WorkableAdapter(),
  smartrecruiters: new SmartRecruitersAdapter(),
  // big-employer careers backends (tier 2: the public JSON their own sites call)
  workday: new WorkdayAdapter(),
  eightfold: new EightfoldAdapter(),
  amazon: new AmazonJobsAdapter(),
  oracle: new OracleHcmAdapter(),
  rippling: new RipplingAdapter(),
  jobvite: new JobviteAdapter(),
  atlassian: new AtlassianAdapter(),
  jibe: new JibeAdapter(),
  talentbrew: new TalentBrewAdapter(),
  // India-market ATSes (tier 2: the public JSON their career pages call)
  keka: new KekaAdapter(),
  zoho: new ZohoRecruitAdapter(),
  freshteam: new FreshteamAdapter(),
  kula: new KulaAdapter(),
  remotive: new RemotiveAdapter(),
  arbeitnow: new ArbeitnowAdapter(),
  hn_whoishiring: new HnWhoIsHiringAdapter(),
  himalayas: new HimalayasAdapter(),
  // key-gated search APIs: return [] (no request) until their env keys are set
  adzuna: new AdzunaSearchAdapter(),
  careerjet: new CareerjetAdapter(),
  jsearch: new JSearchAdapter(), // paid — see docs/configuration.md "Optional sources"
  // India tech boards (tier 2: public, no login)
  hirist: new HiristAdapter(),
  cutshort: new CutshortAdapter(),
  timesjobs: new TimesJobsAdapter(),
  instahyre: new InstahyreAdapter(),
  wellfound: new WellfoundAdapter(),
  reddit: new RedditHiringAdapter(),
  // user-configured feeds (tier 1): fetched only through the SSRF guard (net.ts)
  rss: new RssFeedAdapter(),
  json_feed: new JsonFeedAdapter(),
};

export function getAdapter(source: SourceKind): SourceAdapter | undefined {
  return ADAPTERS[source];
}

/** Map an ATS type to its poller adapter (used by the Company Registry poll loop). */
export function atsAdapter(ats: AtsType): SourceAdapter | undefined {
  if (ats === "unknown") return undefined;
  return ADAPTERS[ats];
}

/** Cloud-safe adapters only (tier 1-2). The orchestrator never runs tier 3 here. */
export function cloudAdapters(): SourceAdapter[] {
  return Object.values(ADAPTERS).filter((a) => a.tier === "tier1" || a.tier === "tier2");
}

/** a cloud adapter by source, or undefined — re-checks the tier (invariant #1). */
export function cloudAdapter(source: string): SourceAdapter | undefined {
  const a = ADAPTERS[source];
  return a && (a.tier === "tier1" || a.tier === "tier2") ? a : undefined;
}

/** cloud adapters that can map a SearchQuery onto their own targets (`toTargets`). */
export function searchCapableAdapters(): SourceAdapter[] {
  return cloudAdapters().filter((a) => typeof a.toTargets === "function");
}
