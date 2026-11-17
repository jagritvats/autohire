import type { RemoteGeo, SourceKind } from "@jobflow/core";
import type { FetchTarget } from "@jobflow/adapters";
import type { SeedCompany } from "../discover.js";

/**
 * One discovery feed = a cloud-safe board adapter + the searches to run on it. These
 * surface roles (and company names) outside the curated registry. Feeds are data, so
 * adding a source is one entry plus its adapter — the poll loop never changes.
 */
export interface DiscoveryFeed {
  source: SourceKind;
  targets: FetchTarget[];
  /** rate-limited to minutes per request (Reddit) — skipped by request-bound refreshes. */
  slow?: boolean;
}

/** a preset's feed, with a STABLE id a tenant can switch off (`presetFeedsDisabled`). */
export interface PresetFeed extends DiscoveryFeed {
  id: string;
}

/**
 * A built-in discovery preset (product plan "Configurable discovery"): what the cron polls
 * for a market — feeds, seed employers, community channels, Tier-3 hubs — plus the profile
 * defaults a new user in that market starts from. Data only; custom sources ADD to it.
 * Presets shape what is polled; ranking still scores every role (invariant #4).
 */
export interface DiscoveryPreset {
  id: string;
  label: string;
  description: string;
  /** ISO-2 markets: country-filtered boards are polled for these. [] = location-agnostic. */
  markets: string[];
  feeds: PresetFeed[];
  seedCompanies: SeedCompany[];
  telegramChannels: string[];
  /** Tier-3 sweep config for the LOCAL agent (never run in the cloud — invariant #1). */
  tier3: { hubs: string[]; queries: string[] } | null;
  profileDefaults: {
    currency: string;
    remoteGeoOk: RemoteGeo[];
    locationWeights: Array<{ label: string; weight: number }>;
  };
}
