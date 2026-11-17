import { describe, expect, it } from "vitest";
import { parseResume, type ResumeDraft, type StoredFile } from "@jobflow/core";
import { InMemoryRepository } from "@jobflow/db";
import { applyResumeImport, blankProfile, completeOnboarding, loadProfile, profileReadiness } from "../src/index.js";

const T = "00000000-0000-0000-0000-0000000000b2";
const NOW = new Date("2026-11-15T00:00:00Z");

// FICTIONAL résumé ("Riley Sample", example.com).
const RESUME = `Riley Sample
riley@example.com | +1 555 010 0199 | github.com/riley-sample

EXPERIENCE
Senior Software Engineer, Example Fintech — Jan 2023 – Present
- Built an idempotent ledger service in Java and Spring Boot handling 2M transactions/day
- Cut p99 API latency from 480ms to 120ms by adding Redis caching

PROJECTS
Queue Lens — open-source Kafka consumer-lag dashboard (TypeScript, React)

SKILLS
Java, Kafka, PostgreSQL, Redis, Figma`;

const draft = (): ResumeDraft => parseResume(RESUME, { format: "text", now: NOW });

describe("loadProfile / profileReadiness", () => {
  it("falls back to a blank profile and reports what's missing", async () => {
    const repo = new InMemoryRepository();
    const p = await loadProfile(repo, T);
    expect(p.tenantId).toBe(T);
    expect(p.masterResume).toBe("");
    expect(profileReadiness(p, 0)).toEqual({ ready: false, missing: ["resume", "skills", "prefs"] });
    // evidence alone is grounding material
    expect(profileReadiness(p, 2).missing).not.toContain("resume");
    const ready = { ...p, masterResume: "x", prefs: { ...p.prefs, stackProfile: ["go"], markets: ["DE"] } };
    expect(profileReadiness(ready, 0)).toEqual({ ready: true, missing: [] });
  });
});

describe("applyResumeImport", () => {
  it("replace: sets the résumé, stack, YoE/level, contact gaps and saves selected evidence", async () => {
    const repo = new InMemoryRepository();
    const d = draft();
    const file: StoredFile = { key: `${T}/resume.pdf`, filename: "resume.pdf", mime: "application/pdf", sha256: "ab", bytes: 10, uploadedAt: NOW.toISOString() };
    const { profile, evidenceAdded } = await applyResumeImport(repo, T, d, { mode: "replace", file });
    expect(profile.masterResume).toBe(d.text);
    expect(profile.prefs.stackProfile).toEqual(d.skills.canonical);
    expect(profile.yoe).toBeCloseTo(d.yoe.value, 5);
    expect(profile.levelBand).toBe("senior");
    expect(profile.prefs.contact).toMatchObject({ firstName: "Riley", lastName: "Sample", email: "riley@example.com", github: "github.com/riley-sample" });
    expect(profile.resumeFile).toEqual(file);
    expect(profile.profileEmbedding).toBeNull();
    expect(evidenceAdded).toBe(d.evidence.length);
    const bank = await repo.listEvidence(T);
    expect(bank.every((e) => e.tenantId === T && e.origin === "resume")).toBe(true);
    expect(await repo.getProfile(T)).toEqual(profile);
  });

  it("merge: unions skills, fills only empty contact, keeps prefs/YoE, dedupes evidence", async () => {
    const repo = new InMemoryRepository();
    const existing = blankProfile(T);
    existing.masterResume = "My older résumé text";
    existing.yoe = 3;
    existing.levelBand = "mid";
    existing.profileEmbedding = [0.1, 0.2];
    existing.prefs = {
      ...existing.prefs,
      homeCountry: "DE",
      markets: ["DE", "NL"],
      salaryFloor: 70_000,
      currency: "EUR",
      stackProfile: ["go", "java"],
      targetArchetypes: ["infra_devops"],
      contact: { ...existing.prefs.contact, email: "riley.work@example.com" },
    };
    await repo.saveProfile(existing);
    const d = draft();
    // one entry already in the bank (different casing/spacing) → not duplicated
    await repo.saveEvidence({
      id: "00000000-0000-0000-0000-00000000e001",
      tenantId: T,
      project: "example  fintech",
      headline: d.evidence[0]!.headline.toUpperCase(),
      detail: "",
      metric: null,
      tags: [],
      embedding: null,
      origin: "manual",
    });

    const { profile, evidenceAdded } = await applyResumeImport(repo, T, d, { mode: "merge" });
    expect(profile.masterResume).toBe("My older résumé text");
    expect(profile.prefs.stackProfile).toEqual(["go", "java", ...d.skills.canonical.filter((s) => s !== "java")]);
    expect(profile.yoe).toBe(3);
    expect(profile.levelBand).toBe("mid");
    expect(profile.prefs.contact.email).toBe("riley.work@example.com"); // not overwritten
    expect(profile.prefs.contact.phone).toBe("+1 555 010 0199"); // gap filled
    expect(profile.prefs).toMatchObject({ homeCountry: "DE", markets: ["DE", "NL"], salaryFloor: 70_000, currency: "EUR", targetArchetypes: ["infra_devops"] });
    expect(profile.profileEmbedding).toBeNull();
    expect(evidenceAdded).toBe(d.evidence.length - 1);
    expect(await repo.listEvidence(T)).toHaveLength(d.evidence.length);

    // re-importing the same draft adds nothing
    const again = await applyResumeImport(repo, T, d, { mode: "merge" });
    expect(again.evidenceAdded).toBe(0);
  });

  it("saves only the accepted / selected evidence", async () => {
    const repo = new InMemoryRepository();
    const d = draft();
    d.evidence[1]!.selected = false;
    expect((await applyResumeImport(repo, T, d, { mode: "replace" })).evidenceAdded).toBe(d.evidence.length - 1);
    const repo2 = new InMemoryRepository();
    const { evidenceAdded } = await applyResumeImport(repo2, T, d, { mode: "replace", acceptEvidence: [1] });
    expect(evidenceAdded).toBe(1);
    expect((await repo2.listEvidence(T))[0]!.headline).toBe(d.evidence[1]!.headline);
  });
});

describe("completeOnboarding", () => {
  it("applies the confirmed patch and stamps onboardedAt", async () => {
    const repo = new InMemoryRepository();
    await applyResumeImport(repo, T, draft(), { mode: "replace" });
    const p = await completeOnboarding(
      repo,
      T,
      { contact: { phone: "+1 555 010 0100" }, prefs: { homeCountry: "US", markets: ["US"] }, yoe: 4, levelBand: "mid", stackProfile: ["java", "kafka", "java"] },
      { now: NOW },
    );
    expect(p.onboardedAt).toBe(NOW.toISOString());
    expect(p.prefs.contact.phone).toBe("+1 555 010 0100");
    expect(p.prefs.contact.email).toBe("riley@example.com");
    expect(p.prefs.homeCountry).toBe("US");
    expect(p.prefs.stackProfile).toEqual(["java", "kafka"]);
    expect(p.yoe).toBe(4);
    expect(profileReadiness(p, 1).ready).toBe(true);
  });
});
