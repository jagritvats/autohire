import type { ParsedLocation } from "../schema/entities.js";
import type { LocationMode, RemoteGeo } from "../schema/enums.js";

/**
 * Location parsing (§11.3) — the false-positive minefield. The high-value move
 * is detecting geo-restricted "remote": a role tagged remote that's actually
 * remote-US-only. Heuristic here; the matcher can escalate to an LLM extraction
 * pass on ambiguous JDs.
 *
 * Precedence: the source's LOCATION string is the structured claim and wins; JD
 * prose only fills gaps. Prose is full of "remote-friendly perks" and "join us",
 * which must not flip an onsite Bengaluru role to remote or a remote role to US-only.
 */

const INDIA_CITIES = /\b(bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|secunderabad|delhi|new delhi|ncr|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|gandhinagar|gift city|vadodara|jaipur|indore|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|mysore|mysuru|mangalore|mangaluru|chandigarh|mohali|bhubaneswar|visakhapatnam|vizag|nagpur|lucknow|india)\b/i;
/** US signal in a LOCATION string (short, structured) — case-insensitive is safe here. */
const US_HINT = /\b(united states|usa|u\.s\.a?\.?|us|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|palo alto|mountain view|menlo park|sunnyvale|san jose|san mateo|redwood city|oakland|portland|dallas|houston|philadelphia|pittsburgh|washington,? d\.?c\.?|remote[ -]?us|us[ -]?based)\b|,\s*(CA|NY|WA|TX|MA|IL|CO|GA|FL|OR|UT|NC|VA|NJ|PA|AZ|MN|MI|OH|DC)\b/i;
const CANADA_HINT = /\b(canada|toronto|vancouver|montreal|ottawa|calgary|waterloo)\b/i;
/** Region-level restrictions that are NOT open to someone in India (Americas-only). */
const AMERICAS_HINT = /\b(north america|americas|latam|latin america|canada)\b/i;
const EU_HINT = /\b(europe|eu|germany|berlin|munich|london|uk|united kingdom|ireland|dublin|amsterdam|netherlands|paris|france|spain|madrid|barcelona|lisbon|portugal|poland|warsaw|emea)\b/i;
const APAC_HINT = /\b(apac|asia[- ]pacific|asia)\b/i;

/**
 * US signal in free JD TEXT. The location-string regex above can't be reused: run
 * case-insensitively over prose, `\bus\b` matches the pronoun ("join us", "contact
 * us") and turned most remote JDs into false "US-only" (§11.3). Here "US" must be
 * upper-case and not part of an all-caps heading like "ABOUT US" / "JOIN US".
 */
const US_TEXT_CS = /(?<!\b(?:ABOUT|JOIN|CONTACT|WITH|OF|TO|FOR|HELP|LET|BY|AT|FROM|ON)\s)\b(US|USA|U\.S\.(?:A\.)?)(?![A-Za-z])/;
const US_TEXT_CI = /\b(united states|us[ -]based|based in the us|us time ?zones?|continental us)\b/i;
function usTextSignal(text: string): boolean {
  return US_TEXT_CS.test(text) || US_TEXT_CI.test(text);
}

const REMOTE_RE = /\bremote\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[ -]?site|in[ -]?office|in[ -]?person|work from office|wfo)\b/i;
/** JD phrasing that says the ROLE itself is remote (vs a "remote-friendly" / "WFH stipend" perk). */
const ROLE_REMOTE_RE = /\b(fully remote|100% remote|remote role|remote position|this (role|position|job) is (fully )?remote|work from anywhere)\b/i;
/** looser — only used when the posting gave no location at all. */
const STRONG_REMOTE_RE = /\b(fully remote|100% remote|remote[- ]first|remote role|remote position|work from anywhere|work from home|wfh|this role is remote)\b/i;

// geo-restriction phrases on "remote" roles
const US_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(us|usa|united states)|us[ -]?only|usa[ -]?only|must (be|reside|live).{0,30}(united states|\bus\b|usa)|(located|based|reside) in the (us|united states)|us work authorization|authorized to work in the (us|united states)|eligible to work in the (us|united states)|us citizens?(hip)?|green card|us persons?|w-?2 (only|employees?))\b/i;
const EU_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(eu|europe|emea|uk)|eu[ -]?only|uk[ -]?only|must (be|reside|live).{0,30}(europe|\beu\b|\buk\b)|right to work in the (uk|eu))\b/i;
const INDIA_OK_RE = /\b(remote[ ,-]*\(?india|india[ -]?(based|remote)|anywhere in india|remote,? india|pan[ -]india|open to (candidates in )?india|work from home.{0,20}india)\b/i;
const WORLDWIDE_RE = /\b(remote[ ,-]*\(?(anywhere|worldwide|global)|work from anywhere|anywhere in the world|fully remote worldwide|worldwide|globally remote)\b/i;

const SPONSORSHIP_NEG = /(no (visa )?sponsorship|not (able|eligible) to sponsor|(do|does|will|can) ?n[o']t (provide|offer|sponsor)[^.]{0,20}sponsor|without sponsorship|unable to sponsor|cannot sponsor)/i;
const SPONSORSHIP_POS = /\b(visa sponsorship|will sponsor|relocation (provided|assistance|support|package)|sponsorship available)\b/i;

const TZ_HINTS: Array<[RegExp, string]> = [
  [/\b(ist|india standard time)\b/i, "Asia/Kolkata"],
  [/\b(pst|pdt|pacific time)\b/i, "America/Los_Angeles"],
  [/\b(est|edt|eastern time)\b/i, "America/New_York"],
  [/\b(cet|cest|central european)\b/i, "Europe/Berlin"],
  [/\b(gmt|utc)\b/i, "UTC"],
];

/** Where the remote geo came from — drives the honest confidence below (§11.3). */
type GeoSource = "loc" | "jd_explicit" | "jd_inferred" | "none";

/**
 * Remote geo from the LOCATION string (Remotive's candidate_required_location, Ashby's
 * "Remote - India", HN's "Remote (US)"). India/worldwide win over a co-listed
 * restriction because a multi-location string ("US; India") means India is an option.
 */
function geoFromLoc(loc: string): RemoteGeo | null {
  if (!loc) return null;
  if (INDIA_CITIES.test(loc)) return "india_ok";
  if (/\b(anywhere|worldwide|global|international)\b/i.test(loc)) return "worldwide";
  if (APAC_HINT.test(loc)) return "apac_ok";
  const us = US_HINT.test(loc) || AMERICAS_HINT.test(loc);
  const eu = EU_HINT.test(loc);
  if (us && eu) return "us_eu";
  if (us) return "us_only";
  if (eu) return "eu_only";
  return null;
}

export function parseLocation(locationRaw: string | null, jdText = ""): ParsedLocation {
  const loc = (locationRaw ?? "").trim();
  const jd = jdText ?? "";

  // 1. mode — location string first; JD prose only fills a gap
  let mode: LocationMode = "unknown";
  if (HYBRID_RE.test(loc)) mode = "hybrid";
  else if (REMOTE_RE.test(loc)) mode = "remote";
  else if (ONSITE_RE.test(loc)) mode = "onsite";
  if (mode === "unknown") {
    if (HYBRID_RE.test(jd)) mode = "hybrid";
    else if (loc) mode = ROLE_REMOTE_RE.test(jd) ? "remote" : "onsite"; // a bare city implies onsite
    else if (STRONG_REMOTE_RE.test(jd)) mode = "remote";
    else if (REMOTE_RE.test(jd)) mode = "remote";
    else if (ONSITE_RE.test(jd)) mode = "onsite";
  }

  // 2. country/city (from the location string only)
  const country = INDIA_CITIES.test(loc)
    ? "India"
    : US_HINT.test(loc)
      ? "United States"
      : CANADA_HINT.test(loc)
        ? "Canada"
        : EU_HINT.test(loc)
          ? "Europe"
          : null;
  const locForCity = loc.replace(/\b(remote|hybrid|on[ -]?site|in[ -]?office|anywhere|worldwide|global)\b/gi, " ");
  const cityMatch = locForCity.match(INDIA_CITIES) ?? locForCity.match(/\b([A-Z][a-zA-Z]+)(?:,|\s|$)/);
  const city = cityMatch ? cityMatch[0].replace(/,$/, "").trim() : null;

  // 3. remote geo — the load-bearing signal (§11.3)
  const indiaSignal = INDIA_OK_RE.test(jd) || INDIA_CITIES.test(loc);
  const usSignal = US_HINT.test(loc) || AMERICAS_HINT.test(loc) || usTextSignal(jd) || US_ONLY_RE.test(jd);
  const euSignal = EU_HINT.test(loc) || EU_ONLY_RE.test(jd);
  let remoteGeo: RemoteGeo = "unknown";
  let geoSource: GeoSource = "none";
  if (mode === "remote") {
    const fromLoc = geoFromLoc(loc);
    if (fromLoc) {
      remoteGeo = fromLoc;
      geoSource = "loc";
    }
    // an explicit JD restriction beats a generic "worldwide" label, never a named India option
    if (remoteGeo === "unknown" || remoteGeo === "worldwide") {
      if (US_ONLY_RE.test(jd)) {
        remoteGeo = "us_only";
        geoSource = "jd_explicit";
      } else if (EU_ONLY_RE.test(jd)) {
        remoteGeo = "eu_only";
        geoSource = "jd_explicit";
      }
    }
    if (remoteGeo === "unknown") {
      if (INDIA_OK_RE.test(jd)) remoteGeo = "india_ok";
      else if (WORLDWIDE_RE.test(jd)) remoteGeo = "worldwide";
      else if (/\b(apac|asia[- ]pacific)\b/i.test(jd)) remoteGeo = "apac_ok";
      if (remoteGeo !== "unknown") geoSource = "jd_explicit";
    }
    // a "remote" role whose only geo hint is US, with no india/worldwide signal → likely us_only
    if (remoteGeo === "unknown" && usSignal && !INDIA_CITIES.test(`${loc} ${jd}`)) {
      remoteGeo = "us_only";
      geoSource = "jd_inferred";
    }
  }

  // 4. timezone
  const haystack = `${loc} ${jd}`;
  let timezone: string | null = null;
  for (const [re, tz] of TZ_HINTS) {
    if (re.test(haystack)) {
      timezone = tz;
      break;
    }
  }
  if (!timezone && country === "India") timezone = "Asia/Kolkata";

  // 5. sponsorship
  const sponsorship = SPONSORSHIP_NEG.test(jd)
    ? false
    : SPONSORSHIP_POS.test(jd)
      ? true
      : null;

  // 6. confidence (§11.3) — how much we trust the geo we just parsed. Be honest:
  //    a lone stray "US" hint on a "remote" role, or a bare capitalized token with
  //    no resolvable country, is a guess and must NOT read as fact downstream.
  const conflicting = [indiaSignal, usSignal, euSignal].filter(Boolean).length > 1;
  const confidence = scoreConfidence(mode, country, city, remoteGeo, geoSource, conflicting);

  return { mode, city, country, timezone, remoteGeo, sponsorship, confidence };
}

/** Deterministic 0..1 confidence for the parsed geo (§11.3). */
function scoreConfidence(
  mode: LocationMode,
  country: string | null,
  city: string | null,
  remoteGeo: RemoteGeo,
  geoSource: GeoSource,
  conflicting: boolean,
): number {
  if (mode === "remote") {
    // the location field is a structured claim; JD prose disagreeing with it lowers trust
    if (geoSource === "loc") return conflicting && remoteGeo !== "india_ok" ? 0.6 : 0.9;
    if (conflicting) return 0.4; // multiple, competing geo hints — unsure which binds
    if (geoSource === "jd_explicit") return remoteGeo === "worldwide" || remoteGeo === "india_ok" ? 0.9 : 0.85;
    if (remoteGeo === "unknown") return 0.35; // "remote" with zero geo info
    return 0.5; // us_only INFERRED from a lone hint — a soft guess, flag it
  }
  if (mode === "hybrid" || mode === "onsite") {
    if (country && city) return 0.85; // explicit city + resolvable country
    if (country) return 0.7;
    if (city) return 0.45; // a capitalized token, but no country we recognize
    return 0.3; // bare / ambiguous
  }
  return 0.2; // mode unknown, nothing resolved
}

/**
 * India-workable = onsite/hybrid in India, OR remote that's open to India
 * (`india_ok` / `worldwide`). Used by the "India-onsite allowed" view filter and
 * as a soft ranking signal — never a hard filter (invariant #4).
 */
export function isIndiaWorkable(loc: ParsedLocation): boolean {
  if (loc.mode === "onsite" || loc.mode === "hybrid") return loc.country === "India";
  if (loc.mode === "remote") return loc.remoteGeo === "india_ok" || loc.remoteGeo === "worldwide";
  return false;
}
