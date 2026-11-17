import { describe, it, expect } from "vitest";
import { scorePosting } from "../src/match/index.js";
import { effectiveHomeCountry, effectiveMarkets, effectiveRemoteGeos } from "../src/match/region.js";
import {
  countryCodeFromText,
  isIndiaWorkable,
  isWorkableIn,
  parseLocation,
  parsedCountryMatches,
  remoteGeosForCountry,
} from "../src/normalize/location.js";
import type { ParsedLocation, Posting, Profile } from "../src/schema/index.js";
import { scorePosting as legacyScorePosting } from "./fixtures/score-legacy.js";

function profile(over: Partial<Profile["prefs"]> = {}, top: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    tenantId: "t1",
    masterResume: "",
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 2,
    levelBand: "mid",
    onboardedAt: null,
    resumeFile: null,
    ...top,
    prefs: {
      salaryFloor: 2_000_000,
      currency: "INR",
      homeCountry: "",
      markets: [],
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [
        { label: "remote", weight: 1 },
        { label: "bengaluru", weight: 0.85 },
        { label: "india", weight: 0.7 },
      ],
      stackMustHaves: [],
      stackProfile: ["java", "kafka", "postgres"],
      remoteGeoOk: ["india_ok", "worldwide"],
      relocate: true,
      targetArchetypes: ["backend", "platform"],
      ...over,
    },
  };
}

function posting(location: ParsedLocation, over: Partial<Posting> = {}): Posting {
  const now = new Date("2026-11-10T00:00:00Z");
  return {
    id: "00000000-0000-0000-0000-0000000000j1",
    companyId: "c1",
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: "1",
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "backend-engineer",
    roleArchetype: "backend",
    levelBand: "mid",
    jdText: "",
    jdSkills: ["java", "kafka"],
    requirements: [],
    location,
    salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: null,
    jdEmbedding: null,
    postedAt: null,
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    status: "active",
    invalidReason: null,
    invalidatedAt: null,
    canonicalId: null,
    dedupKey: "acme|backend",
    ...over,
  };
}

/** a broad spread of parsed locations: every mode × geo × confidence × sponsorship the parser emits. */
const LOCATION_STRINGS: Array<[string | null, string]> = [
  ["Bengaluru, India", ""],
  ["Pune", ""],
  ["Remote - India", ""],
  ["Remote", "fully remote worldwide"],
  ["Remote", "US-only, authorized to work in the US"],
  ["Remote (US)", ""],
  ["Remote - Europe", ""],
  ["Remote - US; Europe", ""],
  ["Remote - APAC", ""],
  ["Remote", ""],
  ["San Francisco, CA", ""],
  ["San Francisco, CA", "We do not sponsor visas. No sponsorship."],
  ["New York, NY", "Visa sponsorship available"],
  ["Berlin, Germany", "no visa sponsorship"],
  ["London, UK", ""],
  ["Toronto, Canada", "unable to sponsor"],
  ["Hybrid - Bengaluru", ""],
  ["Singapore", ""],
  ["Dubai", "no sponsorship"],
  [null, "This is an onsite role in our office"],
  [null, ""],
];
const LOCS: ParsedLocation[] = LOCATION_STRINGS.map(([l, jd]) => parseLocation(l, jd));

describe("effectiveHomeCountry / effectiveMarkets (region-neutral, nothing assumed)", () => {
  it("explicit home wins, then currency, then location labels, else unknown", () => {
    expect(effectiveHomeCountry({ homeCountry: "us", currency: "INR", locationWeights: [] })).toBe("US");
    expect(effectiveHomeCountry({ homeCountry: "", currency: "INR", locationWeights: [] })).toBe("IN");
    expect(effectiveHomeCountry({ currency: "GBP", locationWeights: [] })).toBe("GB");
    expect(effectiveHomeCountry({ currency: "CAD", locationWeights: [] })).toBe("CA");
    expect(effectiveHomeCountry({ currency: "AUD", locationWeights: [] })).toBe("AU");
    expect(effectiveHomeCountry({ currency: "SGD", locationWeights: [] })).toBe("SG");
    // USD/EUR don't pin a country — labels decide, highest weight first
    expect(effectiveHomeCountry({ currency: "USD", locationWeights: [{ label: "remote", weight: 1 }, { label: "bengaluru", weight: 0.8 }] })).toBe("IN");
    expect(effectiveHomeCountry({ currency: "EUR", locationWeights: [{ label: "berlin", weight: 0.6 }, { label: "london", weight: 0.9 }] })).toBe("GB");
    expect(effectiveHomeCountry({ currency: "USD", locationWeights: [{ label: "remote", weight: 1 }] })).toBe("");
    expect(effectiveHomeCountry({ currency: "USD", locationWeights: [] })).toBe("");
  });

  it("markets default to [home], else []", () => {
    expect(effectiveMarkets({ currency: "USD", locationWeights: [], markets: ["us", "gb", "US"] })).toEqual(["US", "GB"]);
    expect(effectiveMarkets({ currency: "INR", locationWeights: [], markets: [] })).toEqual(["IN"]);
    expect(effectiveMarkets({ currency: "USD", locationWeights: [], markets: [] })).toEqual([]);
  });

  it("remote geos open from home are added to the user's own", () => {
    expect(effectiveRemoteGeos({ currency: "USD", homeCountry: "US", locationWeights: [], remoteGeoOk: ["worldwide"] })).toEqual(
      expect.arrayContaining(["worldwide", "us_only", "us_eu"]),
    );
    expect(effectiveRemoteGeos({ currency: "USD", locationWeights: [], remoteGeoOk: ["worldwide"] })).toEqual(["worldwide"]);
  });

  it("countryCodeFromText reads place names", () => {
    expect(countryCodeFromText("Bengaluru")).toBe("IN");
    expect(countryCodeFromText("remote-india")).toBe("IN");
    expect(countryCodeFromText("Berlin")).toBe("DE");
    expect(countryCodeFromText("Toronto")).toBe("CA");
    expect(countryCodeFromText("San Francisco")).toBe("US");
    expect(countryCodeFromText("remote")).toBeNull();
  });
});

describe("isWorkableIn (region-neutral isIndiaWorkable)", () => {
  /** the pre-change isIndiaWorkable, verbatim */
  const legacyIndiaWorkable = (loc: ParsedLocation) =>
    loc.mode === "onsite" || loc.mode === "hybrid"
      ? loc.country === "India"
      : loc.mode === "remote"
        ? loc.remoteGeo === "india_ok" || loc.remoteGeo === "worldwide"
        : false;

  it("isIndiaWorkable and isWorkableIn(loc, ['IN']) are identical to the old rule", () => {
    for (const loc of LOCS) {
      expect(isIndiaWorkable(loc)).toBe(legacyIndiaWorkable(loc));
      expect(isWorkableIn(loc, ["IN"])).toBe(legacyIndiaWorkable(loc));
    }
  });

  it("works for other markets", () => {
    const sf = parseLocation("San Francisco, CA", "");
    const usRemote = parseLocation("Remote (US)", "");
    const berlin = parseLocation("Berlin, Germany", "");
    const indiaRemote = parseLocation("Remote - India", "");
    expect(isWorkableIn(sf, ["US"])).toBe(true);
    expect(isWorkableIn(sf, ["IN"])).toBe(false);
    expect(isWorkableIn(usRemote, ["US"])).toBe(true);
    expect(isWorkableIn(usRemote, ["IN"])).toBe(false);
    expect(isWorkableIn(berlin, ["DE"])).toBe(true); // "Europe" region for a European market
    expect(isWorkableIn(berlin, ["US"])).toBe(false);
    expect(isWorkableIn(indiaRemote, ["US"])).toBe(false);
    expect(isWorkableIn(indiaRemote, ["US"], ["india_ok"])).toBe(true); // the user's own remoteGeoOk
    expect(remoteGeosForCountry("IN")).toEqual(["india_ok", "worldwide"]);
  });

  it("parsedCountryMatches is three-valued", () => {
    expect(parsedCountryMatches("India", "IN")).toBe(true);
    expect(parsedCountryMatches("United States", "IN")).toBe(false);
    expect(parsedCountryMatches("Europe", "DE")).toBeNull();
    expect(parsedCountryMatches("Europe", "IN")).toBe(false);
    expect(parsedCountryMatches(null, "IN")).toBeNull();
  });
});

describe("scoring with a home country (§11.3)", () => {
  it("an India home (INR-inferred or explicit IN) scores EXACTLY like the old India-hard-coded scorer", () => {
    const profiles = [
      profile(), // INR, home inferred
      profile({ homeCountry: "IN", currency: "USD" }), // explicit IN, non-INR currency
      profile({ relocate: false }),
      profile({ remoteGeoOk: ["worldwide"], relocate: false }),
      profile({ remoteGeoOk: ["india_ok", "worldwide", "us_only"] }),
    ];
    let compared = 0;
    for (const p of profiles) {
      for (const loc of LOCS) {
        const post = posting(loc);
        const now = scorePosting(post, p);
        const before = legacyScorePosting(post, p);
        // explicit IN + USD: the legacy scorer also treated home as India — same outputs
        expect(now).toEqual(before);
        compared++;
      }
    }
    expect(compared).toBe(profiles.length * LOCS.length);
  });

  it("a US user's onsite US role is home, not 'abroad' — never excluded for it", () => {
    const us = profile({ homeCountry: "US", currency: "USD", relocate: false, remoteGeoOk: ["worldwide"], salaryFloor: 0, locationWeights: [{ label: "remote", weight: 1 }] });
    const sfNoSponsor = posting(parseLocation("San Francisco, CA", "We do not sponsor visas. No sponsorship."));
    const m = scorePosting(sfNoSponsor, us);
    expect(m.rulePass).toBe(true);
    expect(m.flags.redFlags.join(" ")).not.toMatch(/no sponsorship/i);
    expect(m.flags.locationNote).toMatch(/United States-workable/);
    // …while the same role for an India-home user is the impossible-location exclusion
    const india = profile({ relocate: false });
    expect(scorePosting(sfNoSponsor, india).rulePass).toBe(false);
  });

  it("a US user's US-only remote role is open (not excluded, not flagged as closed)", () => {
    const us = profile({ homeCountry: "US", currency: "USD", remoteGeoOk: ["worldwide"], salaryFloor: 0 });
    const usOnly = posting(parseLocation("Remote (US)", ""));
    expect(usOnly.location.confidence).toBeGreaterThanOrEqual(0.85);
    const m = scorePosting(usOnly, us);
    expect(m.rulePass).toBe(true);
    expect(m.flags.redFlags.join(" ")).not.toMatch(/US-only/);
    // the India user with the same prefs is still excluded (explicit restriction, conf ≥ 0.85)
    expect(scorePosting(usOnly, profile({ remoteGeoOk: ["worldwide"] })).rulePass).toBe(false);
  });

  it("unknown home: nothing is 'abroad' — no onsite exclusion, no visa discount", () => {
    const blank = profile({ currency: "USD", homeCountry: "", relocate: false, remoteGeoOk: ["worldwide"], salaryFloor: 0, locationWeights: [{ label: "remote", weight: 1 }] });
    expect(effectiveHomeCountry(blank.prefs)).toBe("");
    for (const [l, jd] of [
      ["San Francisco, CA", "no sponsorship"],
      ["Bengaluru, India", "no sponsorship"],
      ["Berlin, Germany", "no visa sponsorship"],
    ] as const) {
      const m = scorePosting(posting(parseLocation(l, jd)), blank);
      expect(m.rulePass).toBe(true);
      expect(m.flags.hardExclusionReason).toBeNull();
      expect(m.flags.redFlags.join(" ")).not.toMatch(/sponsorship/i);
    }
  });

  it("a European home treats a 'Europe' onsite role as the right region (no abroad exclusion)", () => {
    const de = profile({ homeCountry: "DE", currency: "EUR", relocate: false, remoteGeoOk: ["worldwide"], salaryFloor: 0 });
    const berlin = posting(parseLocation("Berlin, Germany", "no visa sponsorship"));
    expect(scorePosting(berlin, de).rulePass).toBe(true);
    const sf = posting(parseLocation("San Francisco, CA", "no sponsorship"));
    expect(scorePosting(sf, de).rulePass).toBe(false); // definitely abroad, relocation off
  });
});
