import { EUROPE_CODES, effectiveHomeCountry, effectiveMarkets, isWorkableIn, locationCountryCodes, locationInCountry, normCompany, type Posting, type ProfilePrefs, type SourceKind } from "@jobflow/core";
import type { DiscoveryPreset } from "./types.js";
import { INDIA_PRESET } from "./india.js";
import { US_PRESET } from "./us.js";
import { EU_UK_PRESET } from "./eu-uk.js";
import { GLOBAL_REMOTE_PRESET } from "./global-remote.js";
import { CANADA_PRESET } from "./canada.js";

export * from "./types.js";
export { INDIA_PRESET, DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "./india.js";
export { US_PRESET } from "./us.js";
export { EU_UK_PRESET } from "./eu-uk.js";
export { GLOBAL_REMOTE_PRESET } from "./global-remote.js";
export { CANADA_PRESET } from "./canada.js";
export { REMOTE_FIRST_COMPANIES, US_COMPANIES, EU_UK_COMPANIES, CANADA_COMPANIES } from "./companies.js";

/** the preset existing installs (and an unknown id) fall back to — today's behaviour. */
export const DEFAULT_PRESET_ID = "india";

const PRESETS: readonly DiscoveryPreset[] = [INDIA_PRESET, GLOBAL_REMOTE_PRESET, US_PRESET, EU_UK_PRESET, CANADA_PRESET];

export function listPresets(): DiscoveryPreset[] {
  return [...PRESETS];
}

/** the preset by id, or null when there's no such preset. */
export function getPreset(id: string | null | undefined): DiscoveryPreset | null {
  const key = (id ?? "").trim().toLowerCase();
  return PRESETS.find((p) => p.id === key) ?? null;
}

/**
 * Suggest a preset for a profile (onboarding): the user's home country / markets decide;
 * with neither known, the market-neutral `global-remote`.
 */
export function suggestPreset(prefs: Pick<ProfilePrefs, "currency" | "locationWeights"> & Partial<Pick<ProfilePrefs, "homeCountry" | "markets">>): DiscoveryPreset {
  const home = effectiveHomeCountry(prefs);
  const markets = effectiveMarkets(prefs);
  const first = home || markets[0] || "";
  if (first === "IN") return INDIA_PRESET;
  if (first === "US") return US_PRESET;
  if (first === "CA") return CANADA_PRESET;
  if (first && EUROPE_CODES.has(first)) return EU_UK_PRESET;
  return GLOBAL_REMOTE_PRESET;
}

// ── presets as TAGS (search / feed filter) ──

interface PresetIndex {
  companies: Set<string>;
  sources: Set<SourceKind>;
}
let presetIndex: Map<string, PresetIndex> | null = null;
function indexPresets(): Map<string, PresetIndex> {
  presetIndex ??= new Map(
    PRESETS.map((p) => [
      p.id,
      {
        companies: new Set(p.seedCompanies.map((s) => normCompany(s.name)).filter(Boolean)),
        // ATS sources are the companies' boards (matched by company), not preset-specific feeds
        sources: new Set(p.feeds.map((f) => f.source)),
      },
    ]),
  );
  return presetIndex;
}

/**
 * The presets a posting belongs to — where the role is WORKABLE, not just which feed or
 * company list found it:
 *  - its company is in the preset's company list, or it came from a feed the preset uses, and
 *  - when its location is known, the location fits the preset's markets (a market-less preset
 *    like global-remote takes remote roles open worldwide). A posting whose place we can't
 *    read keeps the tag its company / feed gives it.
 * A US-only remote analyst role found by an India feed was tagged `#india`, and a Mountain
 * View office of an India-list company too (2026-11 feed review); a shared feed (HN,
 * Remotive…) already had to fit — now every path does.
 */
export function presetsForPosting(posting: Pick<Posting, "companyName" | "source"> & Partial<Pick<Posting, "location">>): string[] {
  const co = normCompany(posting.companyName);
  const ix = indexPresets();
  const known = posting.location && locationKnown(posting.location) ? posting.location : null;
  const out: string[] = [];
  for (const p of PRESETS) {
    const entry = ix.get(p.id)!;
    if (!(co && entry.companies.has(co)) && !entry.sources.has(posting.source)) continue;
    if (!known || fitsPreset(known, p)) out.push(p.id);
  }
  return out;
}

/** a location we can judge workability by: a placed office, or a remote role with a stated region */
function locationKnown(loc: Posting["location"]): boolean {
  if (loc.mode === "remote") return loc.remoteGeo !== "unknown" || locationCountryCodes(loc).length > 0;
  if (loc.mode === "onsite" || loc.mode === "hybrid") return locationCountryCodes(loc).length > 0 || !!loc.country;
  return false;
}

function fitsPreset(loc: Posting["location"], p: DiscoveryPreset): boolean {
  if (!p.markets.length) return loc.mode === "remote" && (loc.remoteGeo === "worldwide" || loc.remoteGeo === "unknown");
  // remote within named countries, or remote with only a country named: open when one is a market
  if (loc.mode === "remote" && (loc.remoteGeo === "country_only" || loc.remoteGeo === "unknown")) return p.markets.some((m) => locationInCountry(loc, m) === true);
  return isWorkableIn(loc, p.markets);
}

/** the feed sources of these presets (what a preset-tagged live search asks). */
export function presetFeedSources(ids: readonly string[]): SourceKind[] {
  const out = new Set<SourceKind>();
  for (const id of ids) for (const s of indexPresets().get(id)?.sources ?? []) out.add(s);
  return [...out];
}
