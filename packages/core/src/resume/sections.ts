import type { ResumeSectionKind } from "../schema/resume.js";
import { normalizeResumeText } from "./text.js";

/**
 * Split résumé text into sections by heading (§ onboarding). Only headings from the
 * lexicon start a section — an ALL-CAPS company name or a markdown "### Acme" under
 * Experience stays a line of that section. Headings are recognised in any of the usual
 * dresses: "EXPERIENCE", "## Work History", "Skills:", "**Projects**".
 */
export interface ResumeSectionBlock {
  kind: ResumeSectionKind;
  /** the heading as written ("" for the header block above the first heading) */
  title: string;
  /** non-blank lines, normalized */
  lines: string[];
  /** 1-based line number in the normalized text of each entry in `lines` */
  lineNos: number[];
}

const HEADINGS: Array<[ResumeSectionKind, RegExp]> = [
  ["summary", /^(professional |career |executive )?(summary|profile|overview|objective)$|^about( me)?$|^career objective$|^summary of qualifications$/],
  [
    "experience",
    /^((professional|work|relevant|industry|employment|career|internship|engineering)\s+)?(experience|history)$|^work history$|^employment( history)?$|^experience & internships$|^internships?$|^positions?$/,
  ],
  ["projects", /^((personal|selected|side|academic|key|notable|open[- ]source)\s+)?projects?$|^open[- ]source( contributions)?$|^projects & open source$/],
  ["education", /^education( & training| and training)?$|^academic (background|qualifications)$|^qualifications$/],
  [
    "skills",
    /^((technical|core|key|professional|relevant)\s+)?(skills|competencies)( & (tools|technologies|expertise))?$|^skills (and|&) (tools|technologies|expertise)$|^tech(nical)? stack$|^technologies( & tools)?$|^tools( & technologies)?$|^expertise$/,
  ],
  [
    "other",
    /^(certifications?|licenses?( & certifications)?|awards?( & honou?rs)?|honou?rs( & awards)?|achievements?|accomplishments|publications?|patents?|languages|interests|hobbies|volunteer(ing| experience)?|leadership|activities|extracurricular( activities)?|courses|coursework|relevant coursework|references|talks|speaking|hackathons|positions of responsibility)$/,
  ],
];

/** If `line` is a section heading, its kind + title (+ any inline content after a colon). */
export function matchHeading(line: string): { kind: ResumeSectionKind; title: string; rest: string } | null {
  let l = line.trim();
  if (!l || l.length > 60) return null;
  l = l
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(\*\*|__)(.+)\1$/, "$2")
    .replace(/^[=\-_*\s]+|[=\-_*\s]+$/g, "")
    .trim();
  let rest = "";
  const colon = /^([^:]{2,40}):\s*(.*)$/.exec(l);
  if (colon) {
    l = colon[1]!.trim();
    rest = colon[2]!.trim();
  }
  const key = l.toLowerCase().replace(/\s+/g, " ").replace(/\band\b/g, "&").replace(/\s*&\s*/g, " & ");
  const keyPlain = l.toLowerCase().replace(/\s+/g, " ");
  for (const [kind, re] of HEADINGS) {
    if (re.test(key) || re.test(keyPlain)) {
      // inline content only for list-like sections ("Skills: Java, Go"); "Experience: 5
      // years" in a summary is prose, not a heading
      if (rest && kind !== "skills" && kind !== "other") return null;
      return { kind, title: l, rest };
    }
  }
  return null;
}

/** Split normalized résumé text into a header block + headed sections. */
export function splitSections(text: string): ResumeSectionBlock[] {
  const norm = normalizeResumeText(text);
  const lines = norm.split("\n");
  const blocks: ResumeSectionBlock[] = [{ kind: "header", title: "", lines: [], lineNos: [] }];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const h = matchHeading(line);
    const cur0 = blocks[blocks.length - 1]!;
    // "Languages: Java, Go" / "Tools: Docker" inside a skills section are skill lines
    if (h && !(h.rest && cur0.kind === "skills")) {
      blocks.push({ kind: h.kind, title: h.title, lines: h.rest ? [h.rest] : [], lineNos: h.rest ? [idx + 1] : [] });
      return;
    }
    const cur = blocks[blocks.length - 1]!;
    cur.lines.push(line.replace(/^#{1,6}\s+/, ""));
    cur.lineNos.push(idx + 1);
  });
  return blocks.filter((b, i) => i === 0 || b.lines.length > 0 || b.kind !== "other");
}

/** Lines of every section of a kind, concatenated in order. */
export function sectionLines(sections: ResumeSectionBlock[], kind: ResumeSectionKind): string[] {
  return sections.filter((s) => s.kind === kind).flatMap((s) => s.lines);
}
