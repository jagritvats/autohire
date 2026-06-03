import type { AtsType, SourceKind } from "@jobflow/core";
import type { SourceAdapter } from "./types.js";
import { GreenhouseAdapter } from "./ats/greenhouse.js";
import { LeverAdapter } from "./ats/lever.js";
import { AshbyAdapter } from "./ats/ashby.js";
import { WorkableAdapter } from "./ats/workable.js";
import { RemotiveAdapter } from "./aggregators/remotive.js";
import { ArbeitnowAdapter } from "./aggregators/arbeitnow.js";
import { HnWhoIsHiringAdapter } from "./hn/whoishiring.js";

/** Singleton adapters keyed by source. Add a source = register one line here. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  lever: new LeverAdapter(),
  ashby: new AshbyAdapter(),
  workable: new WorkableAdapter(),
  remotive: new RemotiveAdapter(),
  arbeitnow: new ArbeitnowAdapter(),
  hn_whoishiring: new HnWhoIsHiringAdapter(),
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
