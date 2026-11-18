import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ResumeDraft,
  containsVerbatim,
  draftEvidence,
  estimateYoe,
  extractMetrics,
  findDateRange,
  groundDraft,
  inferLevelBand,
  jsonResumeToDraft,
  latexResumeToText,
  linkedinToDraft,
  matchSkillToken,
  normalizeResumeText,
  parseContact,
  parseDateToken,
  parseResume,
  parseRoles,
  parseSkillLines,
  splitSections,
  type ResumeRole,
} from "../src/index.js";

// Every fixture is the FICTIONAL "Riley Sample" (example.com) — never a real person.
const FIX = join(__dirname, "fixtures/resume");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const NOW = new Date("2026-11-15T00:00:00Z");

const role = (p: Partial<ResumeRole>): ResumeRole => ({
  title: "Software Engineer",
  company: "Example Co",
  start: null,
  end: null,
  current: false,
  bullets: [],
  levelBand: null,
  archetype: "backend",
  ...p,
});

describe("normalizeResumeText", () => {
  it("de-hyphenates across line breaks, unifies bullet glyphs, unglues dates", () => {
    const out = normalizeResumeText(
      ["• one", "▪ two", "– three", "* four", "· five", "Worked on con-", "tributed code", "Acme Pvt. Ltd.July 2023 – Present", "Ledgerly — Double-entry ledger2024", "github.com/riley2020"].join("\n"),
    );
    expect(out.split("\n")).toEqual([
      "- one",
      "- two",
      "- three",
      "- four",
      "- five",
      "Worked on contributed code",
      "Acme Pvt. Ltd. July 2023 – Present",
      "Ledgerly — Double-entry ledger 2024",
      "github.com/riley2020",
    ]);
    // a leading "+" phone or a negative number is not a bullet
    expect(normalizeResumeText("+1 555 010 0199\n-5% churn")).toBe("+1 555 010 0199\n-5% churn");
  });

  it("is idempotent", () => {
    const once = normalizeResumeText(read("riley.txt"));
    expect(normalizeResumeText(once)).toBe(once);
  });
});

describe("splitSections", () => {
  it("recognises ALL-CAPS, markdown, colon and bold headings", () => {
    const s = splitSections(
      ["Riley Sample", "WORK EXPERIENCE", "Engineer, Acme — 2020 – 2022", "## Projects", "Thing — a thing", "Skills:", "Java", "**Education**", "B.S."].join("\n"),
    );
    expect(s.map((x) => x.kind)).toEqual(["header", "experience", "projects", "skills", "education"]);
    expect(s[0]!.lines).toEqual(["Riley Sample"]);
    expect(s[1]!.lineNos).toEqual([3]);
  });

  it("keeps inline skills content and category lines inside the skills section", () => {
    const s = splitSections(["Technical Skills: Java, Go", "Languages: TypeScript", "Tools: Docker"].join("\n"));
    const skills = s.filter((x) => x.kind === "skills");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.lines).toEqual(["Java, Go", "Languages: TypeScript", "Tools: Docker"]);
  });

  it("does not treat prose like 'Experience: 5 years' or a company name as a heading", () => {
    const s = splitSections(["SUMMARY", "Experience: 5 years in fintech", "EXPERIENCE", "ACME PAYMENTS", "Engineer 2020 – 2022"].join("\n"));
    expect(s.map((x) => x.kind)).toEqual(["header", "summary", "experience"]);
    expect(s[2]!.lines).toContain("ACME PAYMENTS");
  });
});

describe("parseContact", () => {
  it("pulls name, email, phone, profiles and location from the header", () => {
    const { contact, locations } = parseContact(read("riley.txt"));
    expect(contact).toMatchObject({
      firstName: "Riley", // ALL-CAPS name title-cased
      lastName: "Sample",
      email: "riley@example.com",
      phone: "+1 555 010 0199",
      linkedin: "linkedin.com/in/riley-sample",
      github: "github.com/riley-sample",
    });
    expect(locations).toEqual(["Austin, TX"]);
  });

  it("reduces a repo URL to the profile, finds a portfolio, ignores date ranges as phones", () => {
    const { contact } = parseContact(
      ["Riley Sample", "riley@example.com | https://riley.example.dev | https://github.com/riley-sample/queue-lens", "2019-2021"].join("\n"),
    );
    expect(contact.github).toBe("github.com/riley-sample");
    expect(contact.portfolio).toBe("riley.example.dev");
    expect(contact.phone).toBeUndefined();
  });
});

describe("skills", () => {
  it("keeps the java / javascript boundary", () => {
    expect(matchSkillToken("JavaScript")).toBe("javascript");
    expect(matchSkillToken("Java")).toBe("java");
    expect(parseSkillLines(["JavaScript, TypeScript, Node.js"]).canonical).not.toContain("java");
    expect(parseSkillLines(["Java, Spring Boot"]).canonical).toEqual(["java"]);
  });

  it("canonicalizes aliases and whole tokens only", () => {
    expect(matchSkillToken("PostgreSQL")).toBe("postgres");
    expect(matchSkillToken("Go")).toBe("go");
    expect(matchSkillToken("k8s")).toBe("kubernetes");
    expect(matchSkillToken("Reactive programming")).toBeNull();
    expect(matchSkillToken("Trust & Safety")).toBeNull();
  });

  it("keeps unknown list entries as unrecognized, drops parenthetical asides", () => {
    const s = parseSkillLines(["- Languages: Java, SQL", "Backend: Kafka (event-driven), REST APIs", "Other: Figma, Technical writing", "Cloud (AWS, GCP)"]);
    // SQL and Figma are dictionary skills now (2026-11 taxonomy pass)
    expect(s.canonical).toEqual(["java", "sql", "kafka", "rest", "figma", "aws", "gcp"]);
    expect(s.unrecognized).toEqual(["Technical writing", "Cloud"]);
  });
});

describe("dates + roles", () => {
  it("parses the usual date-range shapes", () => {
    expect(findDateRange("Jan 2023 – Present")).toMatchObject({ start: "2023-01", end: null, current: true });
    expect(findDateRange("01/2021 - 12/2022")).toMatchObject({ start: "2021-01", end: "2022-12" });
    expect(findDateRange("2019–2021")).toMatchObject({ start: "2019", end: "2021" });
    expect(findDateRange("Sept. 2020 to Current")).toMatchObject({ start: "2020-09", current: true });
    expect(findDateRange("2021-03 — now")).toMatchObject({ start: "2021-03", current: true });
    expect(findDateRange("Raised 2019-2018")).toBeNull(); // end before start
    expect(parseDateToken("July 2023")).toBe("2023-07");
  });

  it("splits title / company across layouts", () => {
    const roles = parseRoles(
      normalizeResumeText(
        [
          "Senior Engineer at Example Fintech | Jan 2023 – Present",
          "• Built things",
          "Placeholder Labs   01/2021 - 12/2022",
          "Backend Developer",
          "• Shipped",
          "Data Engineer @ Demo Health — 2019–2020 — Austin, TX",
          "- Piped",
          "Sample Retail Co, Remote",
          "QA Intern 2018 – 2018",
        ].join("\n"),
      ).split("\n"),
    );
    expect(roles.map((r) => [r.title, r.company, r.start, r.end, r.current])).toEqual([
      ["Senior Engineer", "Example Fintech", "2023-01", null, true],
      ["Backend Developer", "Placeholder Labs", "2021-01", "2022-12", false],
      ["Data Engineer", "Demo Health", "2019", "2020", false],
      ["QA Intern", "Sample Retail Co", "2018", "2018", false],
    ]);
    expect(roles[0]!.levelBand).toBe("senior");
    expect(roles[2]!.archetype).toBe("data_ml");
    expect(roles[3]!.levelBand).toBe("intern");
  });

  it("joins wrapped bullets back onto their bullet", () => {
    const [r] = parseRoles(["Engineer, Acme — 2020 – 2022", "- Shipped a Node.js order API serving", "300 req/s", "- Cut costs by", "half"]);
    expect(r!.bullets).toEqual(["Shipped a Node.js order API serving 300 req/s", "Cut costs by half"]);
  });
});

describe("estimateYoe / inferLevelBand", () => {
  it("unions overlapping roles, runs Present to now, halves internships", () => {
    const roles = [
      role({ title: "Senior Engineer", start: "2023-01", current: true, levelBand: "senior" }), // 47 months to Nov 2026
      role({ start: "2020-06", end: "2022-12" }), // 31 months
      role({ title: "Contractor", start: "2021-03", end: "2021-09" }), // fully overlapped → 0
      role({ title: "Software Intern", start: "2019-05", end: "2019-08", levelBand: "intern" }), // 4 × 0.5
    ];
    const y = estimateYoe(roles, "", NOW);
    expect(y.value).toBeCloseTo((47 + 31 + 2) / 12, 1);
    expect(y.confidence).toBeGreaterThan(0.7);
    expect(y.basis).toMatch(/internships at half weight/);
    expect(inferLevelBand(roles, y)).toMatchObject({ value: "senior" });
  });

  it("falls back to a stated 'N+ years of experience', else zero confidence", () => {
    expect(estimateYoe([], "Engineer with 4+ years of experience in payments", NOW)).toMatchObject({ value: 4, confidence: 0.5 });
    expect(estimateYoe([], "no numbers here", NOW)).toMatchObject({ value: 0, confidence: 0 });
  });

  it("reads level from YoE when titles carry none; interns stay interns", () => {
    expect(inferLevelBand([role({ start: "2024-01", current: true })], { value: 2.9, confidence: 0.8, basis: "" }).value).toBe("mid");
    expect(inferLevelBand([role({ title: "SWE Intern", levelBand: "intern", start: "2025-05", end: "2025-08" })], 0.2).value).toBe("intern");
    expect(inferLevelBand([], { value: 0, confidence: 0, basis: "" })).toMatchObject({ value: "mid", confidence: 0 });
  });
});

describe("parseResume", () => {
  const md = parseResume(read("riley.md"), { format: "markdown", now: NOW });

  it("extracts the full draft from Markdown", () => {
    expect(md.contact).toMatchObject({ firstName: "Riley", lastName: "Sample", email: "riley@example.com", github: "github.com/riley-sample", linkedin: "linkedin.com/in/riley-sample" });
    expect(md.headline).toBe("Backend Engineer");
    expect(md.summary).toMatch(/^Backend engineer with 6\+ years/);
    expect(md.roles).toHaveLength(4);
    expect(md.yoe.value).toBeCloseTo(6.7, 1);
    expect(md.levelBand.value).toBe("senior");
    expect(md.archetypes).toEqual(["backend"]);
    expect(md.skills.canonical).toEqual(expect.arrayContaining(["sql", "figma"]));
    expect(md.skills.unrecognized).toEqual(["Technical writing"]);
    expect(md.text).not.toMatch(/\*\*|^#/m);
    expect(md.warnings).toEqual([]);
  });

  it("drafts evidence whose headline/detail/metric are verbatim source text", () => {
    expect(md.evidence.length).toBe(6);
    const lines = md.text.split("\n");
    for (const e of md.evidence) {
      expect(containsVerbatim(md.text, e.headline)).toBe(true);
      for (const d of e.detail.split("\n").filter(Boolean)) expect(containsVerbatim(md.text, d)).toBe(true);
      for (const m of (e.metric ?? "").split("; ").filter(Boolean)) expect(md.text).toContain(m);
      expect(e.span).not.toBeNull();
      expect(lines[e.span!.line - 1]).toBe(e.span!.text);
      expect(e.origin).toBe("resume");
    }
    const ledger = md.evidence[0]!;
    expect(ledger.project).toBe("Example Fintech");
    expect(ledger.metric).toBe("2M transactions/day; 480ms; 120ms; 3 engineers");
    expect(ledger.tags).toEqual(expect.arrayContaining(["java", "kafka", "redis"]));
    expect(md.evidence.find((e) => e.project === "Queue Lens")).toMatchObject({
      headline: "open-source Kafka consumer-lag dashboard (TypeScript, React)",
      detail: "Used by 40 teams to spot stuck consumers",
    });
  });

  it("produces equivalent skills / roles / YoE across md, txt, tex and JSON Resume", () => {
    const drafts = {
      md,
      txt: parseResume(read("riley.txt"), { format: "text", now: NOW }),
      tex: parseResume(read("riley.tex"), { format: "latex", now: NOW }),
      json: parseResume(read("riley.json"), { format: "json_resume", now: NOW }),
    };
    const shape = (d: ResumeDraft) => ({
      contact: { ...d.contact, portfolio: undefined },
      skills: [...d.skills.canonical].sort(),
      unrecognized: d.skills.unrecognized,
      roles: d.roles.map((r) => [r.title, r.company, r.start, r.end, r.current, r.bullets.length]),
      yoe: d.yoe.value,
      level: d.levelBand.value,
      evidence: d.evidence.map((e) => [e.project, e.headline, e.metric]),
    });
    for (const d of Object.values(drafts)) expect(shape(d)).toEqual(shape(md));
    expect(drafts.tex.latex).toContain("\\documentclass");
    expect(drafts.tex.text).not.toMatch(/\\[a-z]+|[{}]/i);
    expect(drafts.json.evidence[0]!.origin).toBe("json_resume");
  });

  it("imports a LinkedIn export (Profile / Positions / Skills)", () => {
    const files = readdirSync(join(FIX, "linkedin")).map((name) => ({ name, text: read(join("linkedin", name)) }));
    const li = linkedinToDraft(files, { now: NOW });
    expect(li.format).toBe("linkedin");
    expect(li.contact).toMatchObject({ firstName: "Riley", lastName: "Sample", portfolio: "riley.example.dev" });
    expect(li.headline).toBe("Backend Engineer");
    expect(li.roles.map((r) => [r.title, r.company, r.start, r.end, r.current])).toEqual(
      md.roles.map((r) => [r.title, r.company, r.start, r.end, r.current]),
    );
    expect(li.skills.canonical).toEqual(expect.arrayContaining(["java", "javascript", "go", "kafka", "aws", "postgres", "figma"]));
    expect(li.skills.unrecognized).toEqual([]);
    expect(li.evidence.every((e) => e.origin === "linkedin")).toBe(true);
    expect(li.yoe.value).toBeCloseTo(6.7, 1);
  });

  it("treats invalid JSON as text instead of throwing", () => {
    const d = parseResume("{ not json", { format: "json_resume", now: NOW });
    expect(d.warnings[0]).toMatch(/isn't valid JSON/);
  });

  it("JSON Resume without basics warns", () => {
    expect(jsonResumeToDraft({ work: [] }, { now: NOW }).warnings[0]).toMatch(/basics/);
  });

  it("keeps \\href targets and template macro arguments apart in LaTeX", () => {
    const t = latexResumeToText(String.raw`\begin{document}\href{https://riley.example.dev}{Portfolio} \resumeSubheading{Engineer}{2020 -- 2021}{Acme}{Austin, TX}\end{document}`);
    expect(t).toContain("Portfolio (https://riley.example.dev)");
    expect(t).toContain("Engineer | 2020 – 2021 | Acme | Austin, TX");
  });
});

describe("extractMetrics + draftEvidence", () => {
  it("copies numeric claims verbatim and skips years / versions", () => {
    expect(extractMetrics("Cut p99 from 480ms to 120ms (4x) for 10k users in 2023 on Java 17, saving $1.2M and 35%")).toEqual([
      "480ms",
      "120ms",
      "4x",
      "10k users",
      "$1.2M",
      "35%",
    ]);
  });

  it("emits nothing for roles without bullets", () => {
    expect(draftEvidence({ roles: [role({ start: "2020" })], sections: [] })).toEqual([]);
  });
});

describe("groundDraft (invariant #3 gate)", () => {
  const source = read("riley.txt");
  const base = parseResume(source, { format: "text", now: NOW });

  it("keeps grounded content untouched", () => {
    const { draft, dropped } = groundDraft(base, base.text, { now: NOW });
    expect(dropped).toEqual([]);
    expect(draft.evidence).toHaveLength(base.evidence.length);
    expect(draft.skills).toEqual(base.skills);
    expect(draft.contact).toEqual(base.contact);
  });

  it("drops invented metrics, invented skills, paraphrases, contacts and roles", () => {
    const candidate: ResumeDraft = {
      ...base,
      contact: { ...base.contact, phone: "+1 555 999 1234", portfolio: "https://riley-invented.example.dev" },
      skills: { canonical: ["java", "rust", "kafka"], unrecognized: ["Figma", "Quantum computing"] },
      roles: [
        ...base.roles,
        role({ title: "Staff Engineer", company: "Imaginary Corp", start: "2010-01", end: "2018-01" }),
        role({ title: "Senior Software Engineer", company: "Example Fintech", start: "2023-01", current: true, bullets: ["Led a 40-person platform org across 3 continents"] }),
      ],
      evidence: [
        // verbatim → kept
        { ...base.evidence[0]! },
        // invented metric: the source says 2M, not 5M
        { ...base.evidence[0]!, metric: "5M transactions/day" },
        // paraphrase: < 85% of its content tokens are in the source
        { project: "Example Fintech", headline: "Architected a world-class, massively scalable financial ledger platform", detail: "", metric: null, tags: ["java"], origin: "resume", span: null, selected: true },
        // a number in the body that isn't in the source
        { project: "Sample Retail Co", headline: "Shipped a Node.js order API on PostgreSQL serving 900 req/s", detail: "", metric: null, tags: [], origin: "resume", span: null, selected: true },
      ],
      yoe: { value: 15, confidence: 1, basis: "model said so" },
    };
    const { draft, dropped } = groundDraft(candidate, base.text, { now: NOW });
    expect(draft.evidence).toHaveLength(1);
    expect(draft.evidence[0]!.headline).toBe(base.evidence[0]!.headline);
    expect(draft.skills.canonical).toEqual(["java", "kafka"]);
    expect(draft.skills.unrecognized).toEqual(["Figma"]);
    expect(draft.contact.phone).toBeUndefined(); // not the number on the résumé
    expect(draft.contact.email).toBe("riley@example.com");
    expect(draft.contact.portfolio).toBeUndefined();
    expect(draft.roles.map((r) => r.company)).not.toContain("Imaginary Corp");
    expect(draft.roles.find((r) => r.bullets.some((b) => b.includes("40-person")))).toBeUndefined();
    // YoE is recomputed from surviving roles, never taken from the model
    expect(draft.yoe.value).toBeCloseTo(base.yoe.value, 1);
    expect(dropped.join("\n")).toMatch(/metric "5M transactions\/day"/);
    expect(dropped.join("\n")).toMatch(/skill "rust"/);
    expect(dropped.join("\n")).toMatch(/paraphrased or invented/);
    expect(dropped.join("\n")).toMatch(/900/);
    expect(dropped.join("\n")).toMatch(/Imaginary Corp/);
    expect(draft.warnings.filter((w) => w.startsWith("Dropped:")).length).toBe(dropped.length);
  });
});
