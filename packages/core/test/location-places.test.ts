import { describe, expect, it } from "vitest";
import { scorePosting } from "../src/match/index.js";
import { scoreSourceTrust } from "../src/match/trust.js";
import { normalizePosting } from "../src/normalize/index.js";
import {
  countryCodeFromText,
  foldPlace,
  isWorkableIn,
  locationCountries,
  locationCountryCodes,
  locationInCountry,
  parseLocation,
  parsedCountryMatches,
} from "../src/normalize/location.js";
import { RawPosting, type ParsedLocation, type Posting, type Profile } from "../src/schema/index.js";

/**
 * Multi-place locations, European place names and the agency flag (SOURCE_HEALTH.md
 * "Notes for the core / normalization owners", 2026-11-18). Fictional employers only.
 */

const EU_UK = ["GB", "DE", "NL"];

function profile(over: Partial<Profile["prefs"]> = {}): Profile {
  return {
    id: "p1",
    tenantId: "t1",
    masterResume: "",
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 3,
    levelBand: "mid",
    onboardedAt: null,
    resumeFile: null,
    prefs: {
      salaryFloor: 0,
      currency: "GBP",
      homeCountry: "GB",
      markets: [],
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [{ label: "london", weight: 1 }],
      stackMustHaves: [],
      stackProfile: ["go", "postgres"],
      remoteGeoOk: ["eu_only", "worldwide"],
      relocate: false,
      targetArchetypes: ["backend"],
      ...over,
    },
  };
}

function posting(location: ParsedLocation, over: Partial<Posting> = {}): Posting {
  const now = new Date("2026-11-10T00:00:00Z");
  return {
    id: "00000000-0000-0000-0000-0000000000p1",
    companyId: "c1",
    companyName: "Examplecorp",
    atsType: "greenhouse",
    atsJobId: "1",
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "backend-engineer",
    roleArchetype: "backend",
    levelBand: "mid",
    jdText: "Build Go services on Postgres.",
    jdSkills: ["go", "postgres"],
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
    dedupKey: "examplecorp|backend",
    ...over,
  };
}

describe("multi-place locations keep every country", () => {
  it("Greenhouse offices: 'Hybrid - Austin, TX; London, United Kingdom' is US and GB", () => {
    const loc = parseLocation("Hybrid - Austin, TX; London, United Kingdom");
    expect(loc.mode).toBe("hybrid");
    expect(loc.country).toBe("United States"); // the primary stays as before (back-compat)
    expect(loc.countries).toEqual(["US", "GB"]);
    expect(isWorkableIn(loc, EU_UK)).toBe(true); // was false: London didn't count
    expect(isWorkableIn(loc, ["US"])).toBe(true);
    expect(isWorkableIn(loc, ["IN"])).toBe(false);
    expect(isWorkableIn(loc, ["FR"])).toBe(true); // a European office, as "Europe" always was
  });

  it("Workday joined locations and other separators", () => {
    expect(parseLocation("Bengaluru; London").countries).toEqual(["IN", "GB"]);
    expect(parseLocation("Bengaluru; Hyderabad, India").countries).toEqual(["IN"]);
    expect(parseLocation("Toronto, Canada | Berlin, Germany").countries).toEqual(["CA", "DE"]);
    expect(parseLocation("Remote - US or Canada").countries).toEqual(["US", "CA"]);
    expect(parseLocation("Remote (US/Canada)").countries).toEqual(["US", "CA"]);
    expect(parseLocation("Amsterdam / Singapore").countries).toEqual(["NL", "SG"]);
    expect(locationCountries("US-CA-Dublin; Dublin, Ireland")).toEqual(["US", "IE"]);
  });

  it("commas qualify a place, they don't separate places — no phantom second country", () => {
    for (const [raw, codes] of [
      ["Austin, TX, United States", ["US"]],
      ["Dublin, OH", ["US"]],
      ["Paris, TX", ["US"]],
      ["Vienna, VA", ["US"]],
      ["Salem, OR", ["US"]],
      ["Albuquerque, New Mexico", ["US"]],
      ["London, Ontario", ["CA"]],
      ["Porto Alegre, Brazil", ["BR"]],
      ["US-CA-Dublin", ["US"]],
    ] as const) {
      expect(parseLocation(raw).countries, raw).toEqual(codes);
    }
  });

  it("nothing placed → no countries field (old rows and new rows read alike)", () => {
    expect(parseLocation("Remote").countries).toBeUndefined();
    expect(parseLocation("EMEA").countries).toBeUndefined(); // a region, no single country
    expect(locationCountryCodes({ country: "India" })).toEqual(["IN"]);
    expect(locationCountryCodes({ country: "Europe" })).toEqual([]);
  });

  it("locationInCountry: any office counts; 'abroad' only when every office is elsewhere", () => {
    const austinLondon = parseLocation("Hybrid - Austin, TX; London, United Kingdom");
    expect(locationInCountry(austinLondon, "GB")).toBe(true);
    expect(locationInCountry(austinLondon, "US")).toBe(true);
    expect(locationInCountry(austinLondon, "IN")).toBe(false);
    expect(locationInCountry(austinLondon, "DE")).toBeNull(); // European office: same region
    // a location parsed before `countries` existed behaves exactly as parsedCountryMatches
    for (const country of ["India", "United States", "Europe", "Japan", null]) {
      for (const code of ["IN", "US", "DE", "JP", "BR"]) {
        expect(locationInCountry({ country }, code)).toBe(parsedCountryMatches(country, code));
      }
    }
  });

  it("never more 'abroad' than the primary country alone said (the hard rule can only narrow)", () => {
    const raws = [
      "Hybrid - Austin, TX; London, United Kingdom", "Bengaluru; London", "München; Köln", "Durham, United Kingdom",
      "Remote - US or Canada", "Toronto, Canada | Berlin, Germany", "Tokyo; Seoul", "Dublin, OH", "Paris", "Sydney, Australia",
    ];
    for (const raw of raws) {
      const loc = parseLocation(raw);
      for (const code of ["IN", "US", "GB", "DE", "FR", "CA", "JP", "BR"]) {
        if (locationInCountry(loc, code) === false) expect(parsedCountryMatches(loc.country, code), `${raw} vs ${code}`).toBe(false);
      }
    }
  });

  it("the impossible-location rule fires only when NO office is workable", () => {
    const noSponsor = (raw: string) => ({ ...parseLocation(raw, "We are unable to sponsor visas."), sponsorship: false });
    const gb = profile(); // home GB, relocation off
    // an Austin + London role is open to a London resident
    const both = scorePosting(posting(noSponsor("Hybrid - Austin, TX; London, United Kingdom")), gb);
    expect(both.flags.hardExclusionReason).toBeNull();
    expect(both.flags.redFlags.join(" ")).not.toMatch(/no sponsorship/);
    // Austin alone is still abroad, no sponsorship, can't relocate
    expect(scorePosting(posting(noSponsor("Hybrid - Austin, TX")), gb).flags.hardExclusionReason).toMatch(/^Onsite/);
    // for a user in India neither office is home: unchanged (excluded)
    const inUser = profile({ homeCountry: "IN", currency: "INR", locationWeights: [] });
    expect(scorePosting(posting(noSponsor("Hybrid - Austin, TX; London, United Kingdom")), inUser).flags.hardExclusionReason).toMatch(/^Onsite/);
  });

  it("an office at home earns the home-onsite note and no visa discount", () => {
    const loc = parseLocation("Hybrid - Austin, TX; London, United Kingdom");
    const s = scorePosting(posting(loc), profile());
    expect(s.flags.locationNote).toMatch(/United Kingdom-workable/);
    expect(s.flags.redFlags.join(" ")).not.toMatch(/visa sponsorship not mentioned/);
  });
});

describe("European place names (local spellings, diacritic-insensitive)", () => {
  it("folds accents and the letters NFD can't decompose", () => {
    expect(foldPlace("München Köln Zürich Genève København Wrocław Łódź Malmö Straße Æro")).toBe("Munchen Koln Zurich Geneve Kobenhavn Wroclaw Lodz Malmo Strasse AEro");
  });

  it("names the country of local and English spellings", () => {
    for (const [raw, code] of [
      ["München", "DE"], ["Muenchen", "DE"], ["Köln", "DE"], ["Deutschland", "DE"], ["Düsseldorf", "DE"],
      ["Österreich", "AT"], ["Wien", "AT"], ["Vienna, Austria", "AT"],
      ["Zürich", "CH"], ["Genève", "CH"], ["Schweiz", "CH"],
      ["Bruxelles", "BE"], ["Warszawa", "PL"], ["Kraków", "PL"], ["Praha", "CZ"], ["Lisboa", "PT"],
      ["Copenhagen", "DK"], ["København", "DK"], ["Denmark", "DK"],
      ["Oslo", "NO"], ["Norway", "NO"], ["Helsinki", "FI"], ["Finland", "FI"],
      ["Stockholm", "SE"], ["Göteborg", "SE"], ["Milano", "IT"], ["España", "ES"],
    ] as const) {
      const loc = parseLocation(raw);
      expect(loc.country, raw).toBe("Europe");
      expect(loc.countries, raw).toEqual([code]);
      expect(countryCodeFromText(raw), raw).toBe(code);
    }
  });

  it("a 'München; Köln' role (9 at one employer counted nowhere) is a German onsite role", () => {
    const loc = parseLocation("München; Köln");
    expect(loc).toMatchObject({ mode: "onsite", city: "München", country: "Europe", countries: ["DE"] });
    expect(loc.confidence).toBeGreaterThanOrEqual(0.85);
    expect(isWorkableIn(loc, ["DE"])).toBe(true);
    expect(isWorkableIn(loc, EU_UK)).toBe(true);
    expect(isWorkableIn(loc, ["US"])).toBe(false);
  });

  it("an explicit country name beats a city word shared with the US", () => {
    expect(parseLocation("Durham, United Kingdom").countries).toContain("GB");
    expect(countryCodeFromText("Durham, United Kingdom")).toBe("GB");
    expect(countryCodeFromText("Dublin, OH")).toBe("US");
    expect(countryCodeFromText("Dublin")).toBe("IE");
  });

  it("remote roles in a European country read as EU remote", () => {
    expect(parseLocation("Remote - Deutschland").remoteGeo).toBe("eu_only");
    expect(parseLocation("Remote - Österreich").remoteGeo).toBe("eu_only");
  });
});

describe("postedByAgency is set at normalization for every source", () => {
  const raw = (over: Partial<RawPosting>) =>
    RawPosting.parse({ source: "greenhouse", tier: "tier1", atsJobId: "1", companyName: "Examplecorp", title: "Backend Engineer", jdText: "Build Go services.", ...over });

  it("reads the poster's name and the JD when the source doesn't say", () => {
    expect(normalizePosting(raw({ companyName: "Example Staffing Solutions" })).postedByAgency).toBe(true);
    expect(normalizePosting(raw({ source: "himalayas", tier: "tier1", jdText: "We are hiring on behalf of our client, a fintech." })).postedByAgency).toBe(true);
    expect(normalizePosting(raw({})).postedByAgency).toBe(false);
    expect(normalizePosting(raw({ companyName: "Tata Consultancy Services" })).postedByAgency).toBe(false);
  });

  it("the source's own answer wins, a 'no' included", () => {
    expect(normalizePosting(raw({ source: "naukri", tier: "tier3", companyName: "Example Placements", postedByAgency: false })).postedByAgency).toBe(false);
    expect(normalizePosting(raw({ source: "naukri", tier: "tier3", postedByAgency: true })).postedByAgency).toBe(true);
  });

  it("stays a trust signal + flag in scoring, never a filter (invariant #4)", () => {
    const loc = parseLocation("London, United Kingdom");
    const flagged = posting(loc, { companyName: "Example Recruitment", postedByAgency: true });
    const plain = posting(loc);
    const trust = scoreSourceTrust(flagged);
    expect(trust.flags.join(" ")).toMatch(/staffing agency/);
    expect(trust.score).toBeLessThan(scoreSourceTrust(plain).score);
    const s = scorePosting(flagged, profile());
    expect(s.rulePass).toBe(true);
    expect(s.flags.hardExclusionReason).toBeNull();
  });
});

describe("normalizePosting keeps the source's location text", () => {
  it("for exact re-parsing later", () => {
    const n = normalizePosting(
      RawPosting.parse({ source: "greenhouse", tier: "tier1", atsJobId: "9", companyName: "Examplecorp", title: "SRE", locationRaw: "  Hybrid - Austin, TX; London, United Kingdom " }),
    );
    expect(n.locationRaw).toBe("Hybrid - Austin, TX; London, United Kingdom");
    expect(n.location.countries).toEqual(["US", "GB"]);
  });
});

describe("country lists in one segment", () => {
  it("keep every named country, without 'New Mexico' reading as Mexico", () => {
    expect(parseLocation("Remote Europe, USA, Canada, Australia, Singapore, Mexico").countries).toEqual(["US", "CA", "SG", "AU", "MX"]);
    expect(parseLocation("Santa Fe, New Mexico, USA").countries).toEqual(["US"]);
    expect(parseLocation("Albuquerque, New Mexico").countries).toEqual(["US"]);
  });
});
