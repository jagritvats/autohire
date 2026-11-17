import { extractSkillsStrict as extractSkills, matchSkillToken } from "../normalize/skills.js";
import { bulletText, isBulletLine } from "./text.js";

/**
 * Skills-section parsing. Each list entry is canonicalized through the shared alias
 * dictionary (normalize/skills.ts); entries it doesn't know are kept verbatim in
 * `unrecognized` for the user to confirm — never dropped, never guessed.
 */
export interface ParsedSkills {
  canonical: string[];
  unrecognized: string[];
}

/** Split one skills line into list entries ("Backend: Java, Spring Boot (REST)" → …). */
export function skillTokens(line: string): string[] {
  let l = isBulletLine(line) ? bulletText(line) : line.trim();
  // drop a category label: "Backend:", "Languages —"
  l = l.replace(/^[^,:;|]{1,30}?\s*[:：]\s*/, "").replace(/^[A-Z][\w &/]{1,25}\s+[—–]\s+/, "");
  const out: string[] = [];
  // parentheticals: "Kafka (event-driven)" → "Kafka", plus any list inside "(AWS, GCP)"
  const inner: string[] = [];
  l = l.replace(/\(([^)]*)\)/g, (_m, c: string) => {
    inner.push(...c.split(/[,;/|]/));
    return "";
  });
  for (const piece of [...l.split(/\s*[,;|•·]\s*|\s+and\s+|\s*&\s+/), ...inner.map((s) => `\u0000${s}`)]) {
    const fromParen = piece.startsWith("\u0000");
    const p = piece.replace(/^\u0000/, "").trim().replace(/^[-–*•]\s*/, "").replace(/[.:;]+$/, "").trim();
    if (!p) continue;
    // "Docker/Kubernetes" → two entries, but keep "CI/CD", "TCP/IP" whole when known
    const parts = matchSkillToken(p) || !p.includes("/") ? [p] : p.split("/").map((x) => x.trim()).filter(Boolean);
    for (const x of parts) out.push(fromParen ? `\u0000${x}` : x);
  }
  return out;
}

export function parseSkillLines(lines: string[]): ParsedSkills {
  const canonical: string[] = [];
  const unrecognized: string[] = [];
  const seenUnrec = new Set<string>();
  for (const line of lines) {
    for (const tok of skillTokens(line)) {
      const fromParen = tok.startsWith("\u0000");
      const t = tok.replace(/^\u0000/, "");
      const skill = matchSkillToken(t);
      if (skill) {
        if (!canonical.includes(skill)) canonical.push(skill);
        continue;
      }
      // parenthetical asides ("event-driven") and prose fragments aren't list entries
      if (fromParen || t.length > 40 || t.split(/\s+/).length > 4 || !/\p{L}/u.test(t)) continue;
      const key = t.toLowerCase();
      if (!seenUnrec.has(key)) {
        seenUnrec.add(key);
        unrecognized.push(t);
      }
    }
  }
  return { canonical, unrecognized };
}

/**
 * Every canonical skill a text supports: the prose extractor over the whole text plus
 * whole-token matches on list-like fragments. This is the grounding universe for skills —
 * a skill that isn't in here isn't in the candidate's material.
 */
export function skillsInText(text: string): Set<string> {
  const found = new Set(extractSkills(text));
  for (const frag of text.split(/[\n,;|•·()]/)) {
    const s = matchSkillToken(frag.replace(/^[^:]{1,30}:\s*/, "").replace(/^-\s+/, ""));
    if (s) found.add(s);
    for (const part of frag.split("/")) {
      const p = matchSkillToken(part);
      if (p) found.add(p);
    }
  }
  return found;
}
