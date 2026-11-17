import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MAX_RESUME_BYTES,
  ResumeIoError,
  SCANNED_PDF_WARNING,
  detectFormat,
  docxToText,
  extractResume,
  importResumeFile,
  importResumeText,
} from "../src/index.js";

// Fixtures are the FICTIONAL "Riley Sample" persona shared with @jobflow/core's tests.
const FIX = join(__dirname, "../../core/test/fixtures/resume");
const fixture = (f: string) => readFileSync(join(FIX, f));
const NOW = new Date("2026-11-15T00:00:00Z");
const u8 = (s: string) => new TextEncoder().encode(s);

// ── DOCX built in-test from hand-written WordprocessingML ──
const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const p = (text: string, opts: { bullet?: boolean } = {}) =>
  `<w:p><w:pPr>${opts.bullet ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ""}<w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p("Riley Sample")}
<w:p><w:r><w:t>Backend Engineer</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>riley@example.com · Austin, TX · </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>GitHub</w:t></w:r></w:hyperlink></w:p>
${p("EXPERIENCE")}
<w:p><w:r><w:t>Senior Software Engineer, Example Fintech</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Jan 2023 – Present</w:t></w:r></w:p>
${p("Built an idempotent ledger service in Java &amp; Spring Boot handling 2M transactions/day", { bullet: true })}
${p("Cut p99 latency from 480ms to 120ms with Redis &lt;cache&gt;", { bullet: true })}
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Sample Retail Co</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Jun 2020 – Dec 2022</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
${p("Software Engineer")}
${p("Shipped a Node.js order API on PostgreSQL serving 300 req/s", { bullet: true })}
<w:p/>
${p("SKILLS")}
${p("Java, JavaScript, Kafka, Figma")}
${p("INTERESTS")}
<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:p><w:r><w:t>Text box once</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Text box once</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>
</w:body></w:document>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://github.com/riley-sample" TargetMode="External"/></Relationships>`;

function makeDocx(documentXml = DOCUMENT_XML): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(documentXml),
    "word/_rels/document.xml.rels": strToU8(RELS),
  });
}

// ── a minimal, valid one-page PDF (Helvetica text) generated in-test ──
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = lines.length ? `BT /F1 10 Tf 14 TL 50 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET` : "";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  // padded past 8 KB: pdf.js 1.x (inside pdf-parse) mis-reads tiny inputs that Node
  // copies into its shared Buffer pool; real résumé PDFs are far larger
  let out = `%PDF-1.4\n%${"0".repeat(9000)}\n`;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return u8(out);
}

const PDF_LINES = [
  "Riley Sample",
  "Backend Engineer",
  "riley@example.com | +1 555 010 0199 | github.com/riley-sample | Austin, TX",
  "EXPERIENCE",
  "Senior Software Engineer, Example Fintech - Jan 2023 - Present",
  "- Built an idempotent ledger service in Java and Spring Boot handling 2M transactions/day",
  "- Cut p99 API latency from 480ms to 120ms by adding Redis caching",
  "Software Engineer, Sample Retail Co - Jun 2020 - Dec 2022",
  "- Shipped a Node.js order API on PostgreSQL serving 300 req/s",
  "SKILLS",
  "Java, JavaScript, TypeScript, Kafka, PostgreSQL, Redis, Docker",
];

describe("DOCX", () => {
  it("turns paragraphs into lines: bullets, tabs, breaks, table rows, links, entities", () => {
    const text = docxToText(makeDocx());
    const lines = text.split("\n");
    expect(lines).toContain("Riley Sample");
    expect(lines).toContain("riley@example.com · Austin, TX · GitHub (https://github.com/riley-sample)");
    expect(lines).toContain("Senior Software Engineer, Example Fintech\tJan 2023 – Present");
    expect(lines).toContain("- Built an idempotent ledger service in Java & Spring Boot handling 2M transactions/day");
    expect(lines).toContain("- Cut p99 latency from 480ms to 120ms with Redis <cache>");
    expect(lines).toContain("Sample Retail Co | Jun 2020 – Dec 2022");
    expect(text.match(/Text box once/g)).toHaveLength(1);
    // a tab STOP in paragraph properties is not a tab character
    expect(lines).toContain("EXPERIENCE");
  });

  it("imports a DOCX résumé into a draft", async () => {
    const d = await importResumeFile({ filename: "riley.docx", bytes: makeDocx() }, { now: NOW });
    expect(d.format).toBe("docx");
    expect(d.contact).toMatchObject({ firstName: "Riley", lastName: "Sample", email: "riley@example.com", github: "github.com/riley-sample" });
    expect(d.roles.map((r) => [r.title, r.company, r.start, r.end, r.current, r.bullets.length])).toEqual([
      ["Senior Software Engineer", "Example Fintech", "2023-01", null, true, 2],
      ["Software Engineer", "Sample Retail Co", "2020-06", "2022-12", false, 1],
    ]);
    expect(d.skills.canonical).toEqual(expect.arrayContaining(["java", "javascript", "kafka"]));
    expect(d.skills.unrecognized).toEqual(["Figma"]);
    expect(d.evidence[0]!.metric).toBe("2M transactions/day; 480ms; 120ms");
  });
});

describe("detectFormat", () => {
  it("sniffs content before trusting the extension", () => {
    expect(detectFormat({ filename: "resume.txt", bytes: makePdf(PDF_LINES) })).toBe("pdf");
    expect(detectFormat({ filename: "resume.pdf", bytes: makeDocx() })).toBe("docx");
    expect(detectFormat({ filename: "resume.txt", bytes: fixture("riley.tex") })).toBe("latex");
    expect(detectFormat({ filename: "resume.txt", bytes: fixture("riley.json") })).toBe("json_resume");
    expect(detectFormat({ filename: "resume", bytes: fixture("riley.md") })).toBe("markdown");
    expect(detectFormat({ filename: "resume.md", bytes: fixture("riley.txt") })).toBe("markdown");
    expect(detectFormat({ filename: "resume.txt", bytes: fixture("riley.txt") })).toBe("text");
    expect(detectFormat({ filename: "Positions.csv", bytes: fixture("linkedin/Positions.csv") })).toBe("linkedin");
  });

  it("recognises a LinkedIn export zip and rejects other binaries", () => {
    const li = zipSync({ "Basic_LinkedInDataExport/Positions.csv": fixture("linkedin/Positions.csv"), "Basic_LinkedInDataExport/Profile.csv": fixture("linkedin/Profile.csv") });
    expect(detectFormat({ filename: "export.zip", bytes: li })).toBe("linkedin");
    expect(detectFormat({ filename: "photos.zip", bytes: zipSync({ "a.png": new Uint8Array([1, 2, 3]) }) })).toBeNull();
    expect(detectFormat({ filename: "me.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]) })).toBeNull();
  });
});

describe("extractResume / importResumeFile", () => {
  it("reads a text PDF and parses it", async () => {
    const d = await importResumeFile({ filename: "riley.pdf", bytes: makePdf(PDF_LINES) }, { now: NOW });
    expect(d.format).toBe("pdf");
    expect(d.warnings).not.toContain(SCANNED_PDF_WARNING);
    expect(d.contact).toMatchObject({ firstName: "Riley", email: "riley@example.com", github: "github.com/riley-sample" });
    expect(d.roles.map((r) => [r.title, r.company, r.start, r.current])).toEqual([
      ["Senior Software Engineer", "Example Fintech", "2023-01", true],
      ["Software Engineer", "Sample Retail Co", "2020-06", false],
    ]);
    expect(d.skills.canonical).toEqual(expect.arrayContaining(["java", "javascript", "typescript", "kafka", "postgres"]));
  });

  it("warns when a PDF has (almost) no text — a scan", async () => {
    const x = await extractResume({ filename: "scan.pdf", bytes: makePdf([]) });
    expect(x.format).toBe("pdf");
    expect(x.warnings).toContain(SCANNED_PDF_WARNING);
  });

  it("refuses files over 10 MB and unsupported binaries", async () => {
    const big = new Uint8Array(MAX_RESUME_BYTES + 1);
    await expect(extractResume({ filename: "big.pdf", bytes: big })).rejects.toMatchObject({ code: "too_large" });
    await expect(extractResume({ filename: "x.doc", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]) })).rejects.toBeInstanceOf(ResumeIoError);
    await expect(extractResume({ filename: "x.txt", bytes: new Uint8Array() })).rejects.toMatchObject({ code: "empty" });
  });

  it("notes a wrong extension and imports the real format", async () => {
    const d = await importResumeFile({ filename: "riley.pdf", bytes: fixture("riley.tex") }, { now: NOW });
    expect(d.format).toBe("latex");
    expect(d.latex).toContain("\\documentclass");
    expect(d.warnings[0]).toMatch(/named \.pdf but is really LaTeX/);
    expect(d.roles).toHaveLength(4);
  });

  it("imports JSON Resume and a LinkedIn export zip", async () => {
    const json = await importResumeFile({ filename: "resume.json", bytes: fixture("riley.json") }, { now: NOW });
    expect(json.format).toBe("json_resume");
    expect(json.roles).toHaveLength(4);
    const files = Object.fromEntries(readdirSync(join(FIX, "linkedin")).map((n) => [`Export/${n}`, fixture(join("linkedin", n))]));
    const li = await importResumeFile({ filename: "Basic_LinkedInDataExport.zip", bytes: zipSync(files) }, { now: NOW });
    expect(li.format).toBe("linkedin");
    expect(li.roles.map((r) => r.company)).toEqual(["Example Fintech", "Demo Health", "Sample Retail Co", "Placeholder Labs"]);
  });

  it("parses pasted text, recognising markdown", () => {
    expect(importResumeText(fixture("riley.txt").toString("utf8"), { now: NOW }).format).toBe("paste");
    const md = importResumeText(fixture("riley.md").toString("utf8"), { now: NOW });
    expect(md.text).not.toContain("**");
    expect(md.roles).toHaveLength(4);
  });
});
