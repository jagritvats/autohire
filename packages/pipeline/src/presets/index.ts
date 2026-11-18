import { EUROPE_CODES, effectiveHomeCountry, effectiveMarkets, isWorkableIn, normCompany, type Posting, type ProfilePrefs, type SourceKind } from "@jobflow/core";
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
 * The presets a posting belongs to:
 *  - its company is in the preset's company list, or
 *  - it came from a feed only that preset uses, or
 *  - it came from a feed SEVERAL presets share (HN, Remotive…) and its location fits the
 *    preset's markets (a market-less preset like global-remote takes remote roles open
 *    worldwide) — so a shared feed doesn't stamp every tag on every posting.
 */
export function presetsForPosting(posting: Pick<Posting, "companyName" | "source"> & Partial<Pick<Posting, "location">>): string[] {
  const co = normCompany(posting.companyName);
  const ix = indexPresets();
  const sharing = [...ix.values()].filter((x) => x.sources.has(posting.source)).length;
  const out: string[] = [];
  for (const p of PRESETS) {
    const entry = ix.get(p.id)!;
    if (co && entry.companies.has(co)) {
      out.push(p.id);
      continue;
    }
    if (!entry.sources.has(posting.source)) continue;
    if (sharing <= 1 || !posting.location || fitsPreset(posting.location, p)) out.push(p.id);
  }
  return out;
}

function fitsPreset(loc: Posting["location"], p: DiscoveryPreset): boolean {
  if (!p.markets.length) return loc.mode === "remote" && (loc.remoteGeo === "worldwide" || loc.remoteGeo === "unknown");
  return isWorkableIn(loc, p.markets);
}

/** the feed sources of these presets (what a preset-tagged live search asks). */
export function presetFeedSources(ids: readonly string[]): SourceKind[] {
  const out = new Set<SourceKind>();
  for (const id of ids) for (const s of indexPresets().get(id)?.sources ?? []) out.add(s);
  return [...out];
}
