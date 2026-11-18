import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { NORMALIZE_VERSION, NORMALIZE_VERSION_KEY, normCompany, normalizePosting, parseLocation, RawPosting, type Posting } from "@jobflow/core";
import { toNewPosting } from "../src/ingest.js";
import { localEmbedder } from "../src/embedder.js";
import { renormalizeIfStale, renormalizePosting } from "../src/renormalize.js";
import { getPreset, presetsForPosting } from "../src/presets/index.js";

/**
 * Re-normalize v3 (taxonomy pass): stored JDs that kept their markup / entities and titles
 * filed under the old taxonomy are re-derived without a re-poll. Fictional data only.
 */

const HTML_JD =
  "&lt;p&gt;&lt;strong&gt;About Example Data Co&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;3&#43; years of SQL &amp;amp; Tableau&lt;/li&gt;&lt;li&gt;Python or R a plus&lt;/li&gt;&lt;/ul&gt;";

async function storeWith(over: { title: string; jdText: string; locationRaw: string; source?: RawPosting["source"] }) {
  const repo = new InMemoryRepository();
  const co = await repo.upsertCompany({ name: "Example Data Co", nameNorm: normCompany("Example Data Co"), atsType: "greenhouse", atsSlug: "exampledata" });
  const n = normalizePosting(
    RawPosting.parse({ source: over.source ?? "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "1", companyName: co.name, title: over.title, jdText: over.jdText, locationRaw: over.locationRaw }),
  );
  const p = await repo.upsertPosting(await toNewPosting(n, co.id, co.name, localEmbedder));
  return { repo, p };
}

describe("renormalize v3: JD cleanup + title re-derivation on stored rows", () => {
  it("cleans a stored escaped-HTML JD and re-reads what it hid (years, skills)", async () => {
    const { repo, p } = await storeWith({ title: "Data Analyst", jdText: HTML_JD, locationRaw: "Austin, TX" });
    // simulate a row stored by older code: the old archetype, nothing parsed from the markup
    await repo.updatePostingNormalized(p.id, { location: p.location, postedByAgency: false, roleArchetype: "other", jdSkills: [], experience: { min: null, max: null }, titleNorm: "data-analyst" });
    const before = (await repo.getPosting(p.id))!;
    const next = renormalizePosting(before)!;
    expect(next.jdText).not.toMatch(/&lt;|<p>|&#43;|&amp;/);
    expect(next.jdText).toContain("3+ years of SQL & Tableau");
    expect(next.roleArchetype).toBe("data_analytics");
    expect(next.jdSkills).toEqual(expect.arrayContaining(["sql", "tableau", "python", "r"]));
    expect(next.experience).toEqual({ min: 3, max: null });
    const run = await renormalizeIfStale(repo, { force: true });
    expect(run).toMatchObject({ changed: 1, jdCleaned: 1, archetypes: 1, skills: 1, experience: 1 });
    expect((await repo.getPosting(p.id))!.roleArchetype).toBe("data_analytics");
    // idempotent: plain text stays as it is, a second run changes nothing
    expect(renormalizePosting((await repo.getPosting(p.id))!)).toBeNull();
    expect((await renormalizeIfStale(repo, { force: true }))!.changed).toBe(0);
    expect(await repo.getStoreMeta(NORMALIZE_VERSION_KEY)).toBe(String(NORMALIZE_VERSION));
  });

  it("decodes a stored title's entities and re-derives its role type and level", async () => {
    const { repo, p } = await storeWith({ title: "Executive Assistant &amp; Coordinator - Developer Platform", jdText: "Support the platform leadership team.", locationRaw: "Remote (United States)" });
    await repo.updatePostingNormalized(p.id, { location: { ...p.location, city: "United" }, postedByAgency: false, roleArchetype: "infra_devops", levelBand: "staff" });
    const next = renormalizePosting((await repo.getPosting(p.id))!)!;
    expect(next.title).toBe("Executive Assistant & Coordinator - Developer Platform");
    expect(next.roleArchetype).toBe("other");
    expect(next.levelBand).toBeNull();
    expect(next.location.city).toBeNull();
  });

  it("keeps a level / years range the SOURCE stated (not stored apart from parsed ones)", async () => {
    const { repo, p } = await storeWith({ title: "Backend Engineer", jdText: "Go services.", locationRaw: "Pune, India", source: "cutshort" });
    await repo.updatePostingNormalized(p.id, { location: p.location, postedByAgency: false, experience: { min: 2, max: 4 } });
    const next = renormalizePosting((await repo.getPosting(p.id))!);
    expect(next?.experience ?? (await repo.getPosting(p.id))!.experience).toEqual({ min: 2, max: 4 });
  });
});

describe("preset tags follow where the role is workable, not only which feed found it", () => {
  const base = (over: Partial<Posting>) => ({ companyName: "Nobody Inc", source: "greenhouse", ...over }) as Posting;
  it("a US-only remote role from an India-only feed is not #india", () => {
    expect(presetsForPosting(base({ source: "hirist", location: parseLocation("Remote (United States)") }))).not.toContain("india");
    expect(presetsForPosting(base({ source: "hirist", location: parseLocation("Bengaluru, India") }))).toContain("india");
    // a place we can't read keeps the feed's tag
    expect(presetsForPosting(base({ source: "hirist", location: parseLocation("") }))).toContain("india");
  });
  it("an India-list company's US office is not #india", () => {
    const indiaCo = getPreset("india")!.seedCompanies[0]!.name;
    expect(presetsForPosting(base({ companyName: indiaCo, location: parseLocation("Mountain View, CA") }))).not.toContain("india");
    expect(presetsForPosting(base({ companyName: indiaCo, location: parseLocation("Hyderabad, India") }))).toContain("india");
  });
});
