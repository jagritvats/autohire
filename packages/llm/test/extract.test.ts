import { describe, expect, it } from "vitest";
import { parseResume, type ResumeDraft } from "@jobflow/core";
import { EXTRACT_ONLY, createProvider, extractResumeAssisted, type CompletionRequest, type LlmProvider } from "../src/index.js";

// FICTIONAL résumé ("Riley Sample", example.com) laid out so the deterministic parser
// misses things a model can read: no Experience heading, a phone in an odd spot.
const SOURCE = `Riley Sample
riley@example.com
Backend Engineer
Reach me on 555 010 0199 (mobile)

Senior Software Engineer, Example Fintech — Jan 2023 – Present
- Built an idempotent ledger service in Java and Spring Boot handling 2M transactions/day
- Cut p99 API latency from 480ms to 120ms by adding Redis caching

SKILLS
Java, Kafka, PostgreSQL`;
const NOW = new Date("2026-11-15T00:00:00Z");

/** A provider that returns a canned reply and records the request. */
function stub(reply: string | (() => never)): LlmProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    name: "stub",
    calls,
    async complete(req) {
      calls.push(req);
      if (typeof reply === "function") reply();
      return reply as string;
    },
    async embed(texts) {
      return texts.map(() => [0]);
    },
  };
}

const MODEL_REPLY = JSON.stringify({
  contact: {
    firstName: "Riley",
    lastName: "Sample",
    email: "riley@example.com",
    phone: "555 010 0199", // verbatim → fills the gap
    linkedin: "linkedin.com/in/riley-sample", // NOT in the résumé → dropped
    portfolio: "https://riley-invented.example.dev", // invented → dropped
  },
  headline: "Backend Engineer",
  summary: "Seasoned engineer passionate about building world-class distributed platforms", // invented
  skills: ["Java", "Kafka", "PostgreSQL", "Rust", "Kubernetes"], // Rust/Kubernetes invented
  locations: ["Austin, TX"], // invented
  roles: [
    {
      title: "Senior Software Engineer",
      company: "Example Fintech",
      start: "2023-01",
      end: null,
      current: true,
      bullets: [
        "Built an idempotent ledger service in Java and Spring Boot handling 2M transactions/day",
        "Cut p99 API latency from 480ms to 120ms by adding Redis caching",
      ],
    },
    { title: "Staff Engineer", company: "Imaginary Corp", start: "2015-01", end: "2022-12", current: false, bullets: ["Led 200 engineers"] },
  ],
  evidence: [
    // grounded
    {
      project: "Example Fintech",
      headline: "Cut p99 API latency from 480ms to 120ms by adding Redis caching",
      detail: "",
      metric: "480ms to 120ms",
    },
    // invented metric
    {
      project: "Example Fintech",
      headline: "Built an idempotent ledger service in Java and Spring Boot handling 2M transactions/day",
      detail: "",
      metric: "10M transactions/day",
    },
    // paraphrase
    {
      project: "Example Fintech",
      headline: "Architected a massively scalable, best-in-class payments ledger platform",
      detail: "Drove company-wide reliability culture",
      metric: "",
    },
  ],
});

describe("extractResumeAssisted", () => {
  it("returns the baseline untouched on the offline echo provider", async () => {
    const baseline = parseResume(SOURCE, { format: "text", now: NOW });
    const out = await extractResumeAssisted(createProvider({ provider: "echo" }), SOURCE, baseline, { now: NOW });
    expect(out).toBe(baseline);
  });

  it("drops everything the model invented and fills only empty baseline fields", async () => {
    const parsed = parseResume(SOURCE, { format: "text", now: NOW });
    // the deterministic pass found no roles (no Experience heading); pretend it also
    // missed the phone so the model has a contact gap to fill
    expect(parsed.roles).toEqual([]);
    const { phone: _phone, ...contactWithoutPhone } = parsed.contact;
    const baseline: ResumeDraft = { ...parsed, contact: contactWithoutPhone, evidence: [] };

    const llm = stub(MODEL_REPLY);
    const out = await extractResumeAssisted(llm, SOURCE, baseline, { now: NOW });

    expect(llm.calls[0]!.system).toBe(EXTRACT_ONLY);
    expect(llm.calls[0]!.task).toBe("cheap");
    expect(llm.calls[0]!.json).toBe(true);

    expect(out.provenance).toBe("llm_assisted");
    expect(out.text).toBe(baseline.text);
    // contact: verbatim phone filled, invented links dropped, existing fields kept
    expect(out.contact.phone).toBe("555 010 0199");
    expect(out.contact.linkedin).toBeUndefined();
    expect(out.contact.portfolio).toBeUndefined();
    expect(out.contact.email).toBe("riley@example.com");
    // skills: baseline already had some → unchanged (and never the invented ones)
    expect(out.skills.canonical).toEqual(baseline.skills.canonical);
    expect(out.skills.canonical).not.toContain("rust");
    // summary / location: invented → stay empty
    expect(out.summary).toBe("");
    expect(out.locations).toEqual(baseline.locations);
    // roles: baseline had none → the grounded one only; YoE recomputed from it
    expect(out.roles.map((r) => [r.title, r.company, r.start, r.current])).toEqual([["Senior Software Engineer", "Example Fintech", "2023-01", true]]);
    expect(out.yoe.value).toBeCloseTo(47 / 12, 1);
    expect(out.levelBand.value).toBe("senior");
    // evidence: only the verbatim one with a verbatim metric
    expect(out.evidence.map((e) => e.headline)).toEqual(["Cut p99 API latency from 480ms to 120ms by adding Redis caching"]);
    expect(out.evidence[0]!.origin).toBe("resume");
    expect(out.evidence[0]!.tags).toContain("redis");
    // and the user is told what was dropped
    const note = out.warnings.find((w) => w.startsWith("The AI pass suggested"));
    expect(note).toMatch(/rust/);
    expect(note).toMatch(/10M transactions\/day/);
    expect(note).toMatch(/Imaginary Corp/);
  });

  it("does not duplicate evidence the baseline already has", async () => {
    const baseline = parseResume(SOURCE.replace("Riley Sample\n", "Riley Sample\nEXPERIENCE\n").replace("riley@example.com\nBackend Engineer\nReach me on 555 010 0199 (mobile)\n", ""), { format: "text", now: NOW });
    const out = await extractResumeAssisted(stub(MODEL_REPLY), baseline.text, baseline, { now: NOW });
    const headlines = out.evidence.flatMap((e) => [e.headline, ...e.detail.split("\n")]).filter(Boolean);
    expect(new Set(headlines).size).toBe(headlines.length);
  });

  it("falls back to the baseline when the provider fails or replies with junk", async () => {
    const baseline = parseResume(SOURCE, { format: "text", now: NOW });
    const failed = await extractResumeAssisted(stub(() => { throw new Error("rate limited"); }), SOURCE, baseline);
    expect(failed.provenance).toBe("deterministic");
    expect(failed.warnings.at(-1)).toMatch(/rate limited/);
    const junk = await extractResumeAssisted(stub("Sure! Here is the résumé."), SOURCE, baseline);
    expect(junk.roles).toEqual(baseline.roles);
    expect(junk.warnings.at(-1)).toMatch(/no usable JSON/);
  });
});
