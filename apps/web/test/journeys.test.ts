import { describe, expect, it } from "vitest";
import { NAV, activeNav } from "../lib/nav";
import { describeLocation } from "@jobflow/core";
import { experienceText, locationText, payText } from "../lib/cardText";

describe("navigation (the IA every page shares)", () => {
  it("is the job seeker's loop, in order", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Jobs", "Search", "Applications", "Profile", "Sources", "Settings"]);
  });

  it("lights up the right item for nested pages", () => {
    expect(activeNav("/")).toBe("/");
    expect(activeNav("/jobs/abc")).toBe("/");
    expect(activeNav("/tailor/abc")).toBe("/");
    expect(activeNav("/search")).toBe("/search");
    expect(activeNav("/companies")).toBe("/sources");
    expect(activeNav("/company/acme")).toBe("/sources");
    expect(activeNav("/onboarding")).toBe("/profile");
    expect(activeNav("/settings")).toBe("/settings");
    expect(activeNav("/login")).toBeNull();
  });
});

describe("card text (plain language, no internals)", () => {
  /** a card's location as the service builds it (`describeLocation`) */
  const card = (loc: Parameters<typeof describeLocation>[0] & { confidence?: number }) => {
    const d = describeLocation(loc);
    return { location: { mode: loc.mode, label: d.label, place: d.place, places: d.places, remoteGeo: loc.remoteGeo, country: d.country, countries: d.countries, confidence: loc.confidence ?? 1 } };
  };

  it("says where a remote job can be done from — never an empty label", () => {
    expect(locationText(card({ mode: "remote", city: null, country: null, remoteGeo: "worldwide" }))).toBe("Remote · worldwide");
    expect(locationText(card({ mode: "remote", city: null, country: null, remoteGeo: "apac_ok" }))).toBe("Remote · APAC");
    expect(locationText(card({ mode: "remote", city: "Canada", country: "Canada", countries: ["CA"], remoteGeo: "country_only" }))).toBe("Remote · Canada only");
    expect(locationText(card({ mode: "onsite", city: "Pune", country: "India", remoteGeo: "unknown" }))).toBe("Onsite · Pune, India");
    // the real country, not the legacy region "Europe"; the other places are counted
    expect(locationText(card({ mode: "hybrid", city: "München", country: "Europe", countries: ["DE"], remoteGeo: "unknown" }))).toBe("Hybrid · München, Germany");
    expect(locationText(card({ mode: "hybrid", city: "Bengaluru", country: "India", countries: ["IN", "SG"], remoteGeo: "unknown" }))).toBe("Hybrid · Bengaluru, India + Singapore");
  });

  it("never blurs an estimate into stated pay", () => {
    const est = payText({ comp: { label: "est. $150k–190k / yr", confidence: "low", source: "levels", estimate: true, confidenceScore: 0.45, basis: "12 similar" } });
    expect(est?.text).toBe("est. $150k–190k / yr (45% confident)");
    const stated = payText({ comp: { label: "$150k–190k / yr", confidence: "high", source: "jd", estimate: false, confidenceScore: null, basis: null } });
    expect(stated?.text).toBe("$150k–190k / yr");
    expect(payText({ comp: null })).toBeNull();
  });

  it("states what the posting asks, or nothing when it doesn't say", () => {
    expect(experienceText({ min: 3, max: null, fit: null })).toBe("3+ yrs");
    expect(experienceText({ min: 2, max: 5, fit: "ok" })).toBe("2–5 yrs");
    expect(experienceText({ min: null, max: null, fit: null })).toBeNull();
  });
});
