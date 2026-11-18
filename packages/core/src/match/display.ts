import type { ParsedLocation, Posting, ProfilePrefs } from "../schema/entities.js";
import type { RemoteGeo } from "../schema/enums.js";
import { countryDisplayName, isWorkableIn, locationCountryCodes, locationInCountry } from "../normalize/location.js";
import { effectiveHomeCountry, effectiveMarkets, effectiveRemoteGeos } from "./region.js";

/**
 * Plain-language location text for a match card (§11.6) — ONE implementation shared by the
 * web card, the Job page, `jobflow feed`/`show` and the MCP tools, so no surface says
 * "Canada, Canada" or hides a remote role's region behind an empty label.
 *
 *   Remote · worldwide            Remote · Canada only          Remote · US only
 *   Hybrid · München, Germany     Onsite · Bengaluru, India + Singapore
 *   Hybrid · Austin, US + 2 more  (every place in `places`, for the Job page)
 *
 * The country comes from the ISO list the parser keeps (`countries`), not the legacy
 * `country` field, which still says "Europe" for most European places.
 */

/** short names where the long one only costs width on a card line */
const SHORT_COUNTRY: Readonly<Record<string, string>> = { US: "US", GB: "UK", AE: "UAE" };

/** what a remote role's region means for where you may work from, in words */
const REMOTE_GEO_TEXT: Readonly<Record<RemoteGeo, string>> = {
  worldwide: "worldwide",
  us_only: "US only",
  eu_only: "Europe only",
  us_eu: "US or Europe",
  india_ok: "open to India",
  apac_ok: "APAC",
  country_only: "one country only",
  unknown: "region not stated",
};

export interface LocationDisplay {
  /** the whole line: mode · primary place (+ the others) — never empty */
  label: string;
  /** the primary place ("München, Germany"), "" when none is known */
  place: string;
  /** every place the posting names, primary first (the Job page lists them all) */
  places: string[];
  /** the remote region in words ("worldwide", "Canada only"), null for onsite/hybrid */
  remote: string | null;
  /** the primary country's display name ("Germany", not the legacy region "Europe" when known) */
  country: string | null;
  /** ISO-2 codes of every country named, primary first */
  countries: string[];
}

type LocationLike = Pick<ParsedLocation, "mode" | "city" | "country" | "remoteGeo"> & { countries?: readonly string[] | undefined };

function countryName(code: string): string {
  return SHORT_COUNTRY[code] ?? countryDisplayName(code);
}

/** "Canada" for ["CA"], "Canada / Brazil" for two, "Canada / Brazil / Chile …" beyond three */
function countriesText(codes: readonly string[]): string {
  const names = codes.map(countryName);
  return names.slice(0, 3).join(" / ") + (names.length > 3 ? " …" : "");
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function describeLocation(loc: LocationLike): LocationDisplay {
  const codes = locationCountryCodes(loc);
  // the legacy primary name is only a fallback: "Europe" or a country with no ISO row yet
  const primaryCountry = codes[0] ? countryName(codes[0]) : (loc.country ?? "");
  const city = cityCase((loc.city ?? "").trim());
  // "Canada, Canada" / "Singapore, Singapore": a city that IS a country name adds nothing
  const cityIsCountry =
    !!city && (same(city, primaryCountry) || codes.some((c) => same(city, countryDisplayName(c)) || same(city, c)) || same(city, loc.country ?? ""));
  const place = [cityIsCountry ? "" : city, primaryCountry].filter(Boolean).join(", ");
  const others = codes.slice(1).map(countryName).filter((n) => !same(n, primaryCountry));
  const places = [place, ...others].filter(Boolean);
  const where = place ? place + (others.length === 1 ? ` + ${others[0]}` : others.length > 1 ? ` + ${others.length} more` : "") : "";

  if (loc.mode === "remote") {
    // remote WITHIN named countries: say which; a pre-`country_only` row (`unknown` + a
    // named country) says the country without claiming a residency rule
    const remote =
      loc.remoteGeo === "country_only" && codes.length
        ? `${countriesText(codes)} only`
        : loc.remoteGeo === "unknown" && codes.length
          ? countriesText(codes)
          : REMOTE_GEO_TEXT[loc.remoteGeo] ?? loc.remoteGeo.replace(/_/g, " ");
    return { label: `Remote · ${remote}`, place, places, remote, country: codes[0] ? countryDisplayName(codes[0]) : loc.country, countries: codes };
  }
  const mode = loc.mode === "hybrid" ? "Hybrid" : loc.mode === "onsite" ? "Onsite" : "";
  const label = [mode, where].filter(Boolean).join(" · ") || "Location not stated";
  return { label, place, places, remote: null, country: codes[0] ? countryDisplayName(codes[0]) : loc.country, countries: codes };
}

/** "GURGAON" / "bangalore" → "Gurgaon" / "Bangalore"; mixed case ("São Paulo", "McLean") stays */
function cityCase(city: string): string {
  if (!city || (city !== city.toUpperCase() && city !== city.toLowerCase())) return city;
  if (city.length <= 3 && city === city.toUpperCase()) return city; // "NYC", "SF"
  return city.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The employer's name for a card: legal-form noise dropped ("Gebbs Healthcare Solutions Pvt.
 * Ltd." → "Gebbs Healthcare Solutions", "Fluence International, Inc." → "Fluence
 * International") and a board slug spelled out ("acme-pay" → "Acme Pay"). A lowercase
 * one-word brand ("athenahealth", "ixigo") is left as the company writes it.
 */
export function companyDisplayName(name: string): string {
  let n = name.replace(/\s+/g, " ").trim();
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(n)) n = n.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const stripped = n.replace(LEGAL_SUFFIX, "").trim();
  return stripped.length >= 2 ? stripped : n;
}
const LEGAL_SUFFIX = /,?\s+(?:(?:pvt\.?|private)\s+(?:ltd\.?|limited)|inc\.?|llc\.?|l\.l\.c\.|ltd\.?|limited|gmbh|co\.,? ltd\.?|s\.?a\.?s\.?|b\.?v\.?|plc|pte\.? ltd\.?|sdn\.? bhd\.?|ag)$/i;

/** "Germany", "India / Singapore" — the countries a location names, for flag copy */
export function placeCountries(loc: Pick<ParsedLocation, "country"> & { countries?: readonly string[] | undefined }): string {
  const codes = locationCountryCodes(loc);
  return codes.length ? countriesText(codes) : (loc.country ?? "another country");
}

/**
 * Is the role workable for THIS user — an office in their home country or one of their
 * markets, or a remote role open to where they live / a region they said they can work
 * from? `null` when there's no home or market to judge by (nothing is assumed). A soft
 * view signal, never a filter (invariant #4); region-neutral (replaces the India-only flag).
 */
export function workableFor(
  loc: Posting["location"],
  prefs: Pick<ProfilePrefs, "currency" | "locationWeights" | "remoteGeoOk"> & Partial<Pick<ProfilePrefs, "homeCountry" | "markets">>,
): boolean | null {
  const home = effectiveHomeCountry(prefs);
  const markets = [...new Set([home, ...effectiveMarkets(prefs)].filter(Boolean))];
  if (!markets.length) return loc.mode === "remote" && loc.remoteGeo === "worldwide" ? true : null;
  // an office somewhere we couldn't place: unknown, not "no"
  if ((loc.mode === "onsite" || loc.mode === "hybrid") && !loc.country && !locationCountryCodes(loc).length) return null;
  if (isWorkableIn(loc, markets, effectiveRemoteGeos(prefs))) return true;
  // a pre-`country_only` remote row (`unknown` + a named country): open when it's one of yours
  if (loc.mode === "remote" && loc.remoteGeo === "unknown") {
    if (markets.some((m) => locationInCountry(loc, m) === true)) return true;
    return null; // no region stated — can't tell
  }
  return loc.mode === "unknown" ? null : false;
}
