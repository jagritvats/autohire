import { afterEach, describe, expect, it, vi } from "vitest";
import { Profile, latexBodyIssues, splitLatexDocument, type Evidence, type Posting } from "@jobflow/core";
import {
  ProviderError,
  createProvider,
  markdownToLatex,
  plainResumeToMarkdown,
  tailorResume,
  tailorResumeLatex,
  tailorResumeMarkdown,
  writeCoverLetter,
  type CompletionRequest,
  type LlmProvider,
} from "../src/index.js";

// A résumé as pdf-parse extracts it: wrapped lines, glued dates, bullet glyphs, hyphenation.
const PDF_TEXT = `Asha Rao
Backend Engineer
asha@example.com — +91-9000000000 — GitHub
About Me
Backend engineer building event-driven services on Kafka and Spring Boot, with a focus on reliability and
throughput in production.
Skills
Backend:  Java,  Spring  Boot,  Kafka  (event-driven),  REST  APIs,
Multithreading, Concurrency
Databases:  PostgreSQL, Redis
Work Experience
Acme Payments Pvt. Ltd.July 2023 – Present
Software Engineer
•  Owned async payment workflows on Kafka with DLQs and retries, cutting failed settlements by 40% across the
settlement pipeline.
•  Improved service startup time by 2× and con-
tributed to architecture reviews.
Projects
Ledgerly — Double-entry ledger2024
•  Built an idempotent ledger service in Java with Postgres.
Education
Example University2019 – 2023
B.E. Computer Science`;

const JAKE_TEX = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage{titlesec}
\newcommand{\resumeItem}[1]{\item\small{#1}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}}
\begin{document}
\section{Experience}
\resumeItemListStart
  \resumeItem{Owned async payment workflows on Kafka}
\resumeItemListEnd
\section{Education}
Example University
\end{document}
`;

const JD_HTML = `<h3>About Globex</h3><p>Globex moves money for millions of businesses.</p>
<h3>What you'll do</h3><ul><li>Build streaming data pipelines</li></ul>
<h3>Minimum requirements</h3><ul><li>Distributed systems in production</li><li>Java or Scala</li></ul>
<h3>Benefits</h3><p>Free snacks forever.</p>`;

function profile(over: Partial<Profile> = {}): Profile {
  return Profile.parse({
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000002",
    masterResume: PDF_TEXT,
    prefs: { contact: { firstName: "Asha" }, stackProfile: ["java", "kafka", "distributed_systems"] },
    ...over,
  });
}

const posting = {
  id: "00000000-0000-4000-8000-000000000003",
  title: "Software Engineer, Data",
  companyName: "Globex",
  jdText: JD_HTML,
  jdSkills: ["kafka", "distributed_systems", "scala"],
  location: { mode: "hybrid", city: "Bengaluru" },
  levelBand: "mid",
} as unknown as Posting;

const evidence: Evidence[] = [
  {
    id: "00000000-0000-4000-8000-000000000004",
    tenantId: "00000000-0000-4000-8000-000000000002",
    project: "Ledgerly",
    headline: "Idempotent ledger",
    detail: "Double-entry ledger with idempotency keys.",
    metric: null,
    tags: ["java", "distributed_systems"],
    embedding: null,
  },
];

/** A provider that records the request and replies with a canned string. */
function stub(reply: string | ((r: CompletionRequest) => string), name = "anthropic"): LlmProvider & { last?: CompletionRequest } {
  const p: LlmProvider & { last?: CompletionRequest } = {
    name,
    complete: async (r) => {
      p.last = r;
      return typeof reply === "function" ? reply(r) : reply;
    },
    embed: async () => [],
  };
  return p;
}
const echo = stub("[echo:strong] …", "echo");

describe("tailorResumeLatex", () => {
  it("splices the model's body into the candidate's preamble byte-for-byte", async () => {
    const body = "\\section{Experience}\n\\resumeItemListStart\n  \\resumeItem{Built streaming pipelines on Kafka}\n\\resumeItemListEnd\n\\section{Education}\nExample University";
    const llm = stub("```latex\n" + body + "\n```");
    const doc = await tailorResumeLatex(llm, profile({ resumeLatex: JAKE_TEX }), evidence, posting);
    expect(doc.source).toBe("llm");
    expect(doc.warnings).toEqual([]);
    expect(splitLatexDocument(doc.text)!.preamble).toBe(splitLatexDocument(JAKE_TEX)!.preamble);
    expect(doc.text).toContain("Built streaming pipelines on Kafka");
    expect(doc.text.trimEnd().endsWith("\\end{document}")).toBe(true);
  });

  it("takes just the body when the model returns a whole document anyway", async () => {
    const llm = stub("\\documentclass{article}\\usepackage{foo}\\begin{document}\\section{Experience}x\\section{Education}y\\end{document}");
    const doc = await tailorResumeLatex(llm, profile({ resumeLatex: JAKE_TEX }), evidence, posting);
    expect(doc.text).not.toContain("\\usepackage{foo}");
    expect(doc.text).toContain("\\section{Experience}x");
  });

  it("sends the full template, the JD requirements, and asks for the body only", async () => {
    const big = JAKE_TEX.replace("\\section{Education}", `${"\\resumeItem{filler bullet about Kafka}\n".repeat(300)}\\section{Education}`);
    const llm = stub("\\section{Experience}a\\section{Education}b");
    await tailorResumeLatex(llm, profile({ resumeLatex: big }), evidence, posting);
    const prompt = llm.last!.prompt;
    expect(big.length).toBeGreaterThan(9000);
    expect(prompt).toContain("\\section{Education}\nExample University");
    expect(prompt).toContain("Minimum requirements");
    expect(prompt).not.toContain("Free snacks");
    expect(prompt).toMatch(/Output ONLY the document body/);
    expect(llm.last!.requireComplete).toBe(true);
  });

  it("throws on a cut-off body instead of returning a document that won't compile", async () => {
    const llm = stub("\\section{Experience}\n\\resumeItemListStart\n  \\resumeItem{Owned async pay");
    const err = await tailorResumeLatex(llm, profile({ resumeLatex: JAKE_TEX }), evidence, posting).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(422);
    expect((err as ProviderError).detail).toMatch(/unclosed brace/);
  });

  it("warns when the rewrite drops a section", async () => {
    const doc = await tailorResumeLatex(stub("\\section{Experience}only"), profile({ resumeLatex: JAKE_TEX }), evidence, posting);
    expect(doc.warnings[0]).toMatch(/Education/);
  });

  it("surfaces provider errors instead of falling back to a template", async () => {
    const failing: LlmProvider = { name: "anthropic", complete: async () => { throw new ProviderError("Invalid API key", "401", 401); }, embed: async () => [] };
    await expect(tailorResumeLatex(failing, profile({ resumeLatex: JAKE_TEX }), evidence, posting)).rejects.toThrow("Invalid API key");
  });

  it("offline: returns the candidate's own template untouched, marked builtin", async () => {
    const doc = await tailorResumeLatex(echo, profile({ resumeLatex: JAKE_TEX }), evidence, posting);
    expect(doc.source).toBe("builtin");
    expect(doc.text).toContain(JAKE_TEX.trim());
    expect(doc.text.startsWith("% Not tailored")).toBe(true);
  });

  it("offline without a template: typesets the candidate's résumé, not the sample evidence", async () => {
    const doc = await tailorResumeLatex(echo, profile(), evidence, posting);
    expect(doc.source).toBe("builtin");
    expect(doc.text).toContain("Acme Payments");
    expect(latexBodyIssues(splitLatexDocument(doc.text)!.body)).toEqual([]);
  });

  it("rejects a template that isn't a full document", async () => {
    await expect(tailorResumeLatex(stub(""), profile({ resumeLatex: "\\section{x}" }), evidence, posting)).rejects.toThrow(/isn't a full document/);
  });
});

describe("tailorResumeMarkdown", () => {
  it("grounds on the résumé, declared skills and the cleaned JD", async () => {
    const llm = stub("# Asha Rao\n## Experience\n- Built pipelines");
    const doc = await tailorResumeMarkdown(llm, profile({ aboutText: "I like reliable systems." }), evidence, posting);
    expect(doc).toEqual({ text: "# Asha Rao\n## Experience\n- Built pipelines", source: "llm", warnings: [] });
    const p = llm.last!.prompt;
    expect(p).toContain("Acme Payments Pvt. Ltd.July 2023");
    expect(p).toContain("DECLARED SKILLS: java, kafka, distributed systems");
    expect(p).toContain("I like reliable systems.");
    expect(p).toContain("Distributed systems in production");
    expect(p).not.toMatch(/<h3>/);
    expect(llm.last!.system).toMatch(/base résumé, the Evidence Bank, and their declared skills/);
  });

  it("throws when the reply isn't a résumé", async () => {
    await expect(tailorResumeMarkdown(stub("Sure! Here you go."), profile(), evidence, posting)).rejects.toBeInstanceOf(ProviderError);
  });

  it("offline: formats the candidate's own résumé, untailored", async () => {
    const doc = await tailorResumeMarkdown(echo, profile(), evidence, posting);
    expect(doc.source).toBe("builtin");
    expect(doc.text.startsWith("# Asha Rao")).toBe(true);
    expect(doc.text).not.toContain("Ledgerly — Idempotent ledger"); // evidence isn't swapped in
  });
});

describe("tailorResume (bullets)", () => {
  it("throws on malformed JSON from a real model", async () => {
    await expect(tailorResume(stub("not json"), profile(), evidence, posting)).rejects.toThrow(/malformed/);
  });

  it("offline: ranks the candidate's own bullets by JD overlap", async () => {
    const v = await tailorResume(echo, profile(), evidence, posting);
    expect(v.yc_startup[0]).toMatch(/Kafka/);
  });
});

describe("writeCoverLetter", () => {
  it("addresses the company, uses the candidate's note, and signs with their name", async () => {
    const letter = "Dear Hiring Team at Globex,\n\n" + "word ".repeat(120);
    const llm = stub(letter);
    const out = await writeCoverLetter(llm, profile(), evidence, posting, [], "I have used Globex at my current job.");
    expect(out).toBe(letter.trim());
    expect(llm.last!.prompt).toContain('begin "Dear Hiring Team at Globex,"');
    expect(llm.last!.prompt).toContain("I have used Globex at my current job.");
    expect(llm.last!.prompt).toContain("(Asha Rao)");
  });

  it("rejects a letter that's too short", async () => {
    await expect(writeCoverLetter(stub("Dear team, hire me."), profile(), evidence, posting)).rejects.toThrow(/too short/);
  });
});

describe("plainResumeToMarkdown", () => {
  const md = plainResumeToMarkdown(PDF_TEXT);

  it("structures name, sections and bullets", () => {
    expect(md.startsWith("# Asha Rao\n\nBackend Engineer\n\nasha@example.com")).toBe(true);
    expect(md).toContain("## About Me");
    expect(md).toContain("## Work Experience");
    expect(md).toContain("- Owned async payment workflows on Kafka with DLQs and retries, cutting failed settlements by 40% across the settlement pipeline.");
  });

  it("re-joins wraps and hyphenation, and unglues dates", () => {
    expect(md).toContain("reliability and throughput in production.");
    expect(md).toContain("and contributed to architecture reviews.");
    expect(md).toContain("Acme Payments Pvt. Ltd. · July 2023 – Present");
    expect(md).toContain("Ledgerly — Double-entry ledger · 2024");
    expect(md).toContain("Example University · 2019 – 2023");
  });

  it("turns labelled skill lines into bullets, joining their wraps", () => {
    expect(md).toContain("- **Backend:** Java, Spring Boot, Kafka (event-driven), REST APIs, Multithreading, Concurrency");
    expect(md).toContain("- **Databases:** PostgreSQL, Redis");
  });

  it("leaves real Markdown alone", () => {
    expect(plainResumeToMarkdown("# A\n\n## B\n- c")).toBe("# A\n\n## B\n- c");
  });
});

describe("markdownToLatex", () => {
  it("produces a structurally sound document with escaped text", () => {
    const tex = markdownToLatex(plainResumeToMarkdown(PDF_TEXT) + "\n- 50% of P&L via [site](https://x.dev/a_b#c) and snake_case_name, *italic*");
    const split = splitLatexDocument(tex)!;
    expect(latexBodyIssues(split.body)).toEqual([]);
    expect(tex).toContain("{\\LARGE \\textbf{Asha Rao}}");
    expect(tex).toContain("\\section*{Work Experience}");
    expect(tex).toContain("\\textbf{Backend:}");
    expect(tex).toContain("50\\% of P\\&L via \\href{https://x.dev/a_b\\#c}{site} and snake\\_case\\_name, \\textit{italic}");
    expect(tex).toContain("2$\\times$");
  });
});

describe("providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Anthropic: a max_tokens stop throws when the caller requires a complete reply", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: [{ type: "text", text: "\\section{Exp" }], stop_reason: "max_tokens" }), { status: 200 }));
    const llm = createProvider({ provider: "anthropic", apiKey: "k" });
    await expect(llm.complete({ prompt: "x", requireComplete: true, maxTokens: 10 })).rejects.toThrow(/output limit/);
    await expect(llm.complete({ prompt: "x", maxTokens: 10 })).resolves.toBe("\\section{Exp");
  });
});
