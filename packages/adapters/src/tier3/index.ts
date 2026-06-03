import type { ExecutionTier, RawPosting, SourceKind } from "@jobflow/core";
import type { Enrichment, EnrichmentInput, FetchTarget, SourceAdapter } from "../types.js";

/**
 * Tier-3 sources (§1, §7.1): Naukri, AmbitionBox, Glassdoor, LinkedIn. No free API,
 * scrape-hostile. These run EXCLUSIVELY on the local agent, through the user's OWN
 * authenticated browser session, polite-paced, flag-guarded OFF by default. The
 * cloud orchestrator never imports or runs these (they're absent from the cloud
 * registry on purpose).
 *
 * Implementations live with the local agent (a Playwright page already authenticated
 * in the user's session). These classes define the contract + the guard; the actual
 * page-scraping is provided by the local runner so server bundles never carry it.
 */

export class Tier3DisabledError extends Error {}

export interface Tier3Context {
  /** opt-in source list from JOBFLOW_TIER3_SOURCES (csv) */
  enabledSources: string[];
  /** a function that fetches+parses a page in the user's local session; injected by
   *  the local agent. Absent server-side → adapter refuses to run. */
  localFetch?: (url: string) => Promise<string>;
}

abstract class LocalTier3Adapter implements SourceAdapter {
  abstract readonly source: SourceKind;
  readonly tier: ExecutionTier = "tier3";
  constructor(protected ctx: Tier3Context) {}

  protected assertEnabled(): void {
    if (!this.ctx.localFetch) {
      throw new Tier3DisabledError(
        `${this.source} is Tier 3 — runs only on the local agent with your session. No localFetch injected.`,
      );
    }
    if (!this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(
        `${this.source} not in JOBFLOW_TIER3_SOURCES. Opt in per source (default off).`,
      );
    }
  }

  abstract fetch(target: FetchTarget): Promise<RawPosting[]>;
}

/** Naukri: India's largest board. Bonus — job pages embed AmbitionBox ratings, so a
 *  single visit yields jobs + ratings in one pass (§11.5). */
export class NaukriAdapter extends LocalTier3Adapter {
  readonly source = "naukri" as const;
  async fetch(_target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    // Local agent supplies localFetch(searchUrl) → parse listing cards + embedded
    // AmbitionBox rating. Implemented in the local runner, not the cloud bundle.
    return [];
  }
}

export class LinkedInAdapter extends LocalTier3Adapter {
  readonly source = "linkedin" as const;
  async fetch(_target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    return [];
  }
}

/** AmbitionBox / Glassdoor are enrichment sources (ratings + comp), not job spines. */
abstract class LocalTier3Enricher {
  readonly tier: ExecutionTier = "tier3";
  abstract readonly source: SourceKind;
  constructor(protected ctx: Tier3Context) {}
  protected assertEnabled(): void {
    if (!this.ctx.localFetch || !this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(`${this.source} disabled / not local.`);
    }
  }
  abstract enrich(input: EnrichmentInput): Promise<Enrichment | null>;
}

export class AmbitionBoxEnricher extends LocalTier3Enricher {
  readonly source = "ambitionbox" as const;
  async enrich(_input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    return null; // local runner parses the company page → ratings + India comp
  }
}

export class GlassdoorEnricher extends LocalTier3Enricher {
  readonly source = "glassdoor" as const;
  async enrich(_input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    return null; // local runner parses reviews → ratings + interview difficulty
  }
}
