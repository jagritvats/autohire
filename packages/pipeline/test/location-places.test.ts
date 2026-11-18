import { describe, expect, it } from "vitest";
import { InMemoryRepository, type NewPosting } from "@jobflow/db";
import { normalizePosting, parseLocation, RawPosting, type Posting } from "@jobflow/core";
import { presetsForPosting } from "../src/presets/index.js";
import { toNewPosting } from "../src/ingest.js";
import { localEmbedder } from "../src/embedder.js";
import { renormalizePosting, renormalizePostings, type RenormalizedFields, type RenormalizeStore } from "../src/renormalize.js";

/** Multi-place locations reach preset tags and survive ingest; stored rows re-normalize. Fictional data. */

const raw = (over: Partial<RawPosting>) =>
  RawPosting.parse({ source: "hn_whoishiring", tier: "tier1", atsJobId: "1", companyName: "Examplecorp", title: "Backend Engineer", jdText: "Build Go services.", ...over });

describe("preset tags consider every office", () => {
  const tagsFor = (locationRaw: string) => {
    const n = normalizePosting(raw({ locationRaw }));
    return presetsForPosting({ companyName: n.companyName, source: n.source, location: n.location });
  };

  it("a shared-feed role in Austin and London is tagged us AND eu-uk", () => {
    const tags = tagsFor("Hybrid - Austin, TX; London, United Kingdom");
    expect(tags).toContain("us");
    expect(tags).toContain("eu-uk");
    expect(tags).not.toContain("india");
  });

  it("German spellings count for eu-uk (they counted nowhere)", () => {
    expect(tagsFor("München; Köln")).toContain("eu-uk");
    expect(tagsFor("Wien, Österreich")).toContain("eu-uk"); // a European office, as "Europe" always was
    expect(tagsFor("Copenhagen, Denmark")).toContain("eu-uk");
  });
});

describe("ingest keeps the location text and the agency flag", () => {
  it("toNewPosting carries locationRaw + countries; an in-memory repo round-trips them", async () => {
    const n = normalizePosting(raw({ locationRaw: "Hybrid - Austin, TX; London, United Kingdom", companyName: "Example Staffing Partners" }));
    const np: NewPosting = await toNewPosting(n, "c1", n.companyName, localEmbedder);
    expect(np.locationRaw).toBe("Hybrid - Austin, TX; London, United Kingdom");
    expect(np.location.countries).toEqual(["US", "GB"]);
    expect(np.postedByAgency).toBe(true);
    const repo = new InMemoryRepository();
    const stored = await repo.upsertPosting(np);
    expect(stored.location.countries).toEqual(["US", "GB"]);
    expect(stored.locationRaw).toBe("Hybrid - Austin, TX; London, United Kingdom");
  });
});

describe("renormalizePostings (stored rows, no re-poll)", () => {
  function stored(over: Partial<Posting>): Posting {
    const now = new Date("2026-11-10T00:00:00Z");
    return {
      id: "p1", companyId: "c1", companyName: "Examplecorp", atsType: "greenhouse", atsJobId: "1", source: "greenhouse", tier: "tier1",
      title: "Backend Engineer", titleNorm: "backend-engineer", roleArchetype: "backend", levelBand: "mid",
      jdText: "Build Go services.", jdSkills: [], requirements: [],
      // what the old parser stored for "München; Köln": nothing placed
      location: { mode: "onsite", city: "M", country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.45 },
      salary: { min: null, max: null, currency: "EUR", source: "none", confidence: "low" }, experience: { min: null, max: null },
      applyUrl: null, jdEmbedding: null, postedAt: null, firstSeen: now, lastSeen: now, isActive: true, repostCount: 0,
      status: "active", invalidReason: null, invalidatedAt: null, canonicalId: null, dedupKey: "k",
      ...over,
    };
  }
  class FakeStore implements RenormalizeStore {
    writes: Array<{ id: string; patch: RenormalizedFields }> = [];
    constructor(public rows: Posting[]) {}
    async listActivePostings() {
      return this.rows;
    }
    async updatePostingNormalized(id: string, patch: RenormalizedFields) {
      this.writes.push({ id, patch });
      const p = this.rows.find((r) => r.id === id)!;
      p.location = patch.location;
      p.postedByAgency = patch.postedByAgency;
    }
  }

  it("re-parses from locationRaw, sets the agency flag, and is idempotent", async () => {
    const store = new FakeStore([
      stored({ id: "a", locationRaw: "München; Köln" }),
      stored({ id: "b", locationRaw: "Hybrid - Austin, TX; London, United Kingdom", location: parseLocation("Hybrid - Austin, TX") }),
      stored({ id: "c", companyName: "Example Recruitment Services", locationRaw: "Berlin, Germany", location: parseLocation("Berlin, Germany") }),
      // stored before locationRaw was kept: location left alone, agency still re-read
      stored({ id: "d", locationRaw: null, jdText: "We are hiring on behalf of our client." }),
      // Naukri flags agencies itself: its stored answer is kept
      stored({ id: "e", source: "naukri", tier: "tier3", companyName: "Example Placements", postedByAgency: false, locationRaw: "Pune", location: parseLocation("Pune") }),
    ]);
    const s1 = await renormalizePostings(store);
    expect(s1).toMatchObject({ scanned: 5, changed: 4, locations: 2, multiCountry: 1, placed: 1, agencyFlagged: 2, agencyCleared: 0, noRaw: 1 });
    const byId = (id: string) => store.rows.find((r) => r.id === id)!;
    expect(byId("a").location).toMatchObject({ country: "Germany", countries: ["DE"], city: "München" });
    expect(byId("b").location.countries).toEqual(["US", "GB"]);
    expect(byId("c").postedByAgency).toBe(true);
    expect(byId("d").location.city).toBe("M");
    expect(byId("d").postedByAgency).toBe(true);
    expect(byId("e").postedByAgency).toBe(false);
    // a second run changes nothing
    store.writes = [];
    const s2 = await renormalizePostings(store);
    expect(s2.changed).toBe(0);
    expect(store.writes).toHaveLength(0);
    expect(renormalizePosting(byId("a"))).toBeNull();
  });
});
