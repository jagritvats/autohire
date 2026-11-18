import type { ExperienceRange, ParsedLocation } from "../schema/entities.js";
import { LevelBandOrder, type LevelBand } from "../schema/enums.js";
import { EUROPE_CODES, locationCountryCodes } from "../normalize/location.js";

/**
 * The pay market a posting is priced in (§11.4). Salaries are only comparable inside one
 * market: a Bengaluru and a San Francisco backend role differ ~5× in nominal pay, so the
 * estimator never borrows comps across markets — it converts nothing, it just refuses.
 * `REMOTE` pools remote roles open beyond one country (priced in USD by convention).
 */
export type SalaryMarket = "IN" | "US" | "CA" | "GB" | "EU" | "SG" | "AU" | "REMOTE";

export const MARKET_CURRENCY: Readonly<Record<SalaryMarket, string>> = {
  IN: "INR",
  US: "USD",
  CA: "CAD",
  GB: "GBP",
  EU: "EUR",
  SG: "SGD",
  AU: "AUD",
  REMOTE: "USD",
};

export const MARKET_LABEL: Readonly<Record<SalaryMarket, string>> = {
  IN: "India",
  US: "the US",
  CA: "Canada",
  GB: "the UK",
  EU: "Europe",
  SG: "Singapore",
  AU: "Australia",
  REMOTE: "remote roles",
};

const UK_CITY = /\b(london|manchester|edinburgh|glasgow|bristol|cambridge|oxford|leeds|belfast|birmingham|reading|united kingdom|uk)\b/i;
const SG_CITY = /\bsingapore\b/i;
const AU_CITY = /\b(sydney|melbourne|brisbane|perth|adelaide|canberra|australia)\b/i;

/** the pay market of one country (ISO-2); null for a country with no market of its own. */
export function salaryMarketOfCountry(code: string): SalaryMarket | null {
  switch (code) {
    case "IN":
    case "US":
    case "CA":
    case "GB":
    case "SG":
    case "AU":
      return code;
  }
  return EUROPE_CODES.has(code) ? "EU" : null;
}

/**
 * Market from the parsed location; null when we can't tell (no estimate beats a wrong one).
 *
 * A posting naming several countries ("Austin, TX; London") is priced in ONE market. The
 * estimate is per posting in a shared corpus, not per viewer, so "the viewer's country" is
 * no answer: the PRIMARY country (`locationCountryCodes(loc)[0]`) decides. The one exception
 * is a posting that STATES its pay currency (`statedCurrency`): the band is evidence of where
 * it is paid, so the first named country whose market is priced in that currency wins — a
 * GBP band on "New York; London" is a London comparable, not a dropped US one.
 */
export function salaryMarketOf(loc: ParsedLocation, statedCurrency?: string | null): SalaryMarket | null {
  const codes = locationCountryCodes(loc);
  const remote = loc.mode === "remote" ? remoteMarketFor(loc, codes) : null;
  // a remote role open beyond its named countries stays in the pooled REMOTE market
  if (statedCurrency && codes.length > 1 && remote !== "REMOTE") {
    for (const c of codes) {
      const m = salaryMarketOfCountry(c);
      if (m && MARKET_CURRENCY[m] === statedCurrency) return m;
    }
  }
  if (remote) return remote;
  const city = loc.city ?? "";
  // legacy rows: the region "Europe" with no country list
  if (loc.country === "Europe") return UK_CITY.test(city) ? "GB" : "EU";
  const primary = codes[0] ? salaryMarketOfCountry(codes[0]) : null;
  if (primary) return primary;
  if (UK_CITY.test(city)) return "GB";
  if (SG_CITY.test(city)) return "SG";
  if (AU_CITY.test(city)) return "AU";
  return null;
}

function remoteMarketFor(loc: ParsedLocation, codes: readonly string[]): SalaryMarket {
  switch (loc.remoteGeo) {
    case "india_ok":
      return "IN";
    case "us_only":
    case "us_eu":
      return "US";
    case "eu_only":
      return codes[0] === "GB" || UK_CITY.test(loc.city ?? "") ? "GB" : "EU";
    default:
      // an explicit single-country remote ("Remote - India") is priced in that country
      if (codes[0] === "IN" || loc.country === "India") return "IN";
      if (codes[0] === "US" || loc.country === "United States") return "US";
      return "REMOTE";
  }
}

/** Currency a posting's location implies — resolves a bare "$" and unlabeled structured pay. */
export function currencyHintFor(loc: ParsedLocation): string | null {
  const m = salaryMarketOf(loc);
  return m ? MARKET_CURRENCY[m] : null;
}

/** Ordinal the ladders index by: LevelBandOrder (intern 0 … director 6). */
export const MID_LEVEL = LevelBandOrder.mid;

/**
 * Seniority as a ladder index. The title's band wins; else the years the JD asks for
 * (the recruiter's own filter); else assume mid and say so (`known: false` costs the
 * estimate confidence rather than pretending).
 */
export function salaryLevelOf(
  levelBand: LevelBand | null | undefined,
  experience?: ExperienceRange | null,
): { index: number; known: boolean } {
  if (levelBand) return { index: LevelBandOrder[levelBand], known: true };
  const min = experience?.min;
  if (min != null) {
    const index = min < 2 ? 1 : min < 5 ? 2 : min < 8 ? 3 : min < 12 ? 4 : 5;
    return { index, known: true };
  }
  return { index: MID_LEVEL, known: false };
}

/**
 * Pay multiplier per level relative to mid (index 2), per market. Grounded in levels.fyi
 * software-engineer medians (Sept 2026): India entry ₹13.6L / all ₹30.3L / senior ₹49.8L
 * (entry÷senior 0.27); US entry $144k / all $195k / senior $251k (0.57). India's ladder is
 * far steeper, so one global ladder would mis-shift every cross-level comp.
 * Indices: intern, junior, mid, senior, staff/lead, principal/manager, director.
 */
const LADDER: Readonly<Record<"IN" | "DEFAULT", readonly number[]>> = {
  IN: [0.2, 0.47, 1, 1.65, 2.5, 3.3, 4.2],
  DEFAULT: [0.55, 0.74, 1, 1.28, 1.6, 1.95, 2.3],
};

/** Multiply a `from`-level salary by this to price it at the `to` level in `market`. */
export function ladderRatio(market: SalaryMarket, from: number, to: number): number {
  const l = market === "IN" ? LADDER.IN : LADDER.DEFAULT;
  const f = l[clampIndex(from)]!;
  const t = l[clampIndex(to)]!;
  return t / f;
}

function clampIndex(i: number): number {
  return Math.max(0, Math.min(6, Math.round(i)));
}
