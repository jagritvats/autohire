import { describe, expect, it } from "vitest";
import { NAV, activeNav } from "../lib/nav";
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
  it("says where a remote job can be done from", () => {
    expect(locationText({ location: { mode: "remote", label: "", remoteGeo: "worldwide", country: null, confidence: 1 } })).toBe("Remote · anywhere");
    expect(locationText({ location: { mode: "onsite", label: "Pune, IN", remoteGeo: "unknown", country: "IN", confidence: 1 } })).toBe("Onsite · Pune, IN");
  });

  it("never blurs an estimate into stated pay", () => {
    const est = payText({ comp: { label: "$150k–$190k", confidence: "low", source: "levels", estimate: true, confidenceScore: 0.45, basis: "12 similar" } });
    expect(est?.text).toBe("~$150k–$190k (estimate · 45% confident)");
    const stated = payText({ comp: { label: "$150k–$190k", confidence: "high", source: "jd", estimate: false, confidenceScore: null, basis: null } });
    expect(stated?.text).toBe("$150k–$190k");
    expect(payText({ comp: null })).toBeNull();
  });

  it("states what the posting asks, or nothing when it doesn't say", () => {
    expect(experienceText({ min: 3, max: null, fit: null })).toBe("3+ yrs");
    expect(experienceText({ min: 2, max: 5, fit: "ok" })).toBe("2–5 yrs");
    expect(experienceText({ min: null, max: null, fit: null })).toBeNull();
  });
});
