import { describe, expect, it } from "vitest";
import { jdForPrompt, jdSections, latexBodyIssues, latexSectionTitles, splitLatexDocument, texEscape } from "../src/index.js";

const GREENHOUSE_HTML = `<h2>Who we are</h2>
<h3>About Acme</h3>
<p>Acme is a financial infrastructure platform. Our mission is to grow the GDP of the internet &amp; more.</p>
<h3>About the team</h3>
<p>The Data Foundations team builds data infrastructure.</p>
<h2>What you&rsquo;ll do</h2>
<ul><li>Build streaming pipelines on Kafka</li><li>Own services end to end</li></ul>
<h3>Minimum requirements</h3>
<ul><li>3+ years building distributed systems</li><li>Java or Scala</li></ul>
<h2>Benefits</h2>
<p>Free lunch, gym, and a great 401k.</p>
<p><strong>Equal opportunity</strong></p>
<p>Acme is an equal opportunity employer.</p>`;

describe("jdForPrompt", () => {
  it("strips HTML, decodes entities, and drops benefits / EEO", () => {
    const out = jdForPrompt(GREENHOUSE_HTML);
    expect(out).not.toMatch(/<[a-z]/i);
    expect(out).toContain("What you’ll do:");
    expect(out).toContain("- Build streaming pipelines on Kafka");
    expect(out).not.toContain("Free lunch");
    expect(out).not.toContain("equal opportunity employer");
  });

  it("puts what the role asks for before the company pitch", () => {
    const out = jdForPrompt(GREENHOUSE_HTML);
    expect(out.indexOf("Minimum requirements")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Minimum requirements")).toBeLessThan(out.indexOf("Acme is a financial infrastructure"));
    expect(out.indexOf("About the team")).toBeLessThan(out.indexOf("About Acme"));
  });

  it("keeps requirements even when the company pitch alone exceeds the budget", () => {
    const html = `<h3>About Acme</h3><p>${"Acme is great. ".repeat(200)}</p><h3>Requirements</h3><ul><li>Kafka in production</li></ul>`;
    const out = jdForPrompt(html, 1000);
    expect(out).toContain("Kafka in production");
    expect(out.length).toBeLessThanOrEqual(1002);
  });

  it("handles double-escaped HTML", () => {
    const out = jdForPrompt("&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;");
    expect(out).toBe("Requirements:\n- Go");
  });

  it("splits plain-text boards on colon and bare headings", () => {
    const text = [
      "About Paytm:",
      "Paytm is a payments company.",
      "About the Role",
      "You will build ad infrastructure.",
      "Experience with Kafka",
      "Minimum requirements",
      "- 2+ years of Java",
    ].join("\n");
    const sections = jdSections(text);
    expect(sections.map((s) => [s.heading, s.kind])).toEqual([
      ["About Paytm", "company"],
      ["About the Role", "role"],
      ["Minimum requirements", "role"],
    ]);
    // a bulletless list line is content, not a heading
    expect(sections[1]!.text).toContain("Experience with Kafka");
  });

  it("passes a heading-less JD through as cleaned text", () => {
    expect(jdForPrompt("We build   things.\n\nYou know Rust.")).toBe("We build things.\nYou know Rust.");
  });

  it("returns empty for empty input", () => {
    expect(jdForPrompt("")).toBe("");
  });
});

const JAKE_LIKE = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage{titlesec}
% \begin{document} in a comment must not split here
\newcommand{\resumeItem}[1]{\item\small{#1}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}}
\begin{document}
\section{Experience}
\resumeItemListStart
  \resumeItem{Built Kafka pipelines with 99.9\% uptime}
\resumeItemListEnd
\section{Education}
Chitkara University
\end{document}
`;

describe("splitLatexDocument", () => {
  it("splits at the real \\begin{document}, ignoring commented ones", () => {
    const split = splitLatexDocument(JAKE_LIKE)!;
    expect(split.preamble.endsWith("\\begin{document}")).toBe(true);
    expect(split.preamble).toContain("\\newcommand{\\resumeItemListEnd}");
    expect(split.body).toContain("\\section{Education}");
    expect(split.body).not.toContain("\\end{document}");
    expect(split.preamble + split.body + "\\end{document}\n").toBe(JAKE_LIKE);
  });

  it("returns null for a fragment", () => {
    expect(splitLatexDocument("\\section{x}")).toBeNull();
    expect(splitLatexDocument("\\documentclass{article}\\begin{document}no end")).toBeNull();
  });
});

describe("latexBodyIssues", () => {
  it("accepts a sound body (escaped braces and \\\\ line breaks included)", () => {
    expect(latexBodyIssues(splitLatexDocument(JAKE_LIKE)!.body)).toEqual([]);
    expect(latexBodyIssues("a \\{ b \\} c \\\\ {\\bf d} % unbalanced { in a comment")).toEqual([]);
  });

  it("flags a body cut off mid-document", () => {
    const cut = "\\section{Experience}\n\\resumeItemListStart\n  \\resumeItem{Built Kafka pipe";
    const issues = latexBodyIssues(cut);
    expect(issues.some((i) => i.includes("unclosed brace"))).toBe(true);
    expect(issues.some((i) => i.includes("resumeItemListStart"))).toBe(true);
  });

  it("flags unclosed and mismatched environments", () => {
    expect(latexBodyIssues("\\begin{itemize}\\item a")).toContain("\\begin{itemize} is never closed");
    expect(latexBodyIssues("\\begin{itemize}\\end{center}")[0]).toMatch(/does not match/);
  });

  it("flags preamble commands and empty bodies", () => {
    expect(latexBodyIssues("\\documentclass{article}")).toContain("the body contains preamble commands");
    expect(latexBodyIssues("  % only a comment\n")).toEqual(["the body is empty"]);
  });

  it("lists section titles in order", () => {
    expect(latexSectionTitles(splitLatexDocument(JAKE_LIKE)!.body)).toEqual(["Experience", "Education"]);
  });
});

describe("texEscape", () => {
  it("escapes specials and maps symbols pdflatex can't typeset", () => {
    expect(texEscape("P&L 50% #1 a_b")).toBe("P\\&L 50\\% \\#1 a\\_b");
    expect(texEscape("Intern→ SDE, 2× faster, ₹20L")).toBe("Intern$\\rightarrow$ SDE, 2$\\times$ faster, Rs.~20L");
    expect(texEscape("shipped 🚀")).toBe("shipped ");
  });
});
