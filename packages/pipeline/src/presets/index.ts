import { EUROPE_CODES, effectiveHomeCountry, effectiveMarkets, normCompany, type Posting, type ProfilePrefs, type SourceKind } from "@jobflow/core";
import type { DiscoveryPreset } from "./types.js";
import { INDIA_PRESET } from "./india.js";
import { US_PRESET } from "./us.js";
import { EU_UK_PRESET } from "./eu-uk.js";
import { GLOBAL_REMOTE_PRESET } from "./global-remote.js";

export * from "./types.js";
export { INDIA_PRESET, DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "./india.js";
export { US_PRESET } from "./us.js";
export { EU_UK_PRESET } from "./eu-uk.js";
export { GLOBAL_REMOTE_PRESET } from "./global-remote.js";
export { REMOTE_FIRST_COMPANIES, US_COMPANIES, EU_UK_COMPANIES } from "./companies.js";

/** the preset existing installs (and an unknown id) fall back to — today's behaviour. */
export const DEFAULT_PRESET_ID = "india";

const PRESETS: readonly DiscoveryPreset[] = [INDIA_PRESET, GLOBAL_REMOTE_PRESET, US_PRESET, EU_UK_PRESET];

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
 * The presets a posting belongs to: its company is in a preset's company list, or it came
 * from one of the preset's feeds (a feed shared by several presets tags all of them).
 */
export function presetsForPosting(posting: Pick<Posting, "companyName" | "source">): string[] {
  const co = normCompany(posting.companyName);
  const out: string[] = [];
  for (const [id, ix] of indexPresets()) if ((co && ix.companies.has(co)) || ix.sources.has(posting.source)) out.push(id);
  return out;
}

/** the feed sources of these presets (what a preset-tagged live search asks). */
export function presetFeedSources(ids: readonly string[]): SourceKind[] {
  const out = new Set<SourceKind>();
  for (const id of ids) for (const s of indexPresets().get(id)?.sources ?? []) out.add(s);
  return [...out];
}
