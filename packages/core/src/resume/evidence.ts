import type { EvidenceOrigin } from "../schema/enums.js";
import type { EvidenceDraft, ResumeRole, SourceSpan } from "../schema/resume.js";
import { extractSkillsStrict as extractSkills } from "../normalize/skills.js";
import type { ResumeSectionBlock } from "./sections.js";
import { findDateRange } from "./dates.js";
import { bulletText, isBulletLine, normalizeForMatch } from "./text.js";

/**
 * Evidence Bank drafts (§4) from the résumé's own bullets — one per role and one per
 * project. `headline`, `detail` and `metric` are COPIED from the source (verbatim
 * substrings; nothing paraphrased, summarised or "improved"), so every entry is a claim
 * the candidate already made (invariant #3). The user reviews them before they're saved.
 */

const UNIT =
  String.raw`(?:users|customers|clients|merchants|sellers|members|students|requests|req\/s|rps|qps|tps|transactions(?:\/(?:day|sec|s|month))?|events(?:\/s(?:ec)?)?|messages|records|rows|orders|downloads|installs|stars|services|deployments|pipelines|daily active users|monthly (?:active )?users|DAU|MAU|endpoints|repos|teams|engineers|countries|cities)`;
/**
 * Numeric claims worth surfacing as a metric: "40%", "2×", "120ms", "$1.2M", "2M
 * transactions/day", "300 req/s", "10k users". Bare numbers (years, version numbers,
 * "3 engineers" without a unit we know) are not metrics.
 */
export const METRIC_RE = new RegExp(
  String.raw`(?:[$₹€£]\s?\d[\d,]*(?:\.\d+)?\s?(?:[kKmMbB]n?\b|million|billion|lakhs?|crores?|L\b|Cr\b)?` +
    String.raw`|\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×|ms\b|μs\b|sec(?:onds?)?\b|seconds?\b|mins?\b|minutes?\b|hours?\b|hrs?\b|days?\b(?=\s+to\b)|[kKmMbB]\+?(?![\w])|million|billion|lakhs?|crores?|\+)` +
    String.raw`(?:\s?${UNIT})?` +
    String.raw`|\d[\d,]*(?:\.\d+)?\s?${UNIT})`,
  "g",
);

/** Verbatim numeric claims in a text, in order, deduped. */
export function extractMetrics(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(METRIC_RE)) {
    const v = m[0].trim();
    if (!/\d/.test(v)) continue;
    // "2023+" or a year range isn't a metric
    if (/^(19|20)\d{2}\+?$/.test(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function metricOf(texts: string[]): string | null {
  const ms = extractMetrics(texts.join("\n"));
  return ms.length ? ms.join("; ") : null;
}

/** Locate a bullet in the sections → a span pointing at its source line. */
function spanFor(sections: ResumeSectionBlock[], text: string, kinds: string[]): SourceSpan | null {
  const needle = normalizeForMatch(text).slice(0, 60);
  if (!needle) return null;
  for (const s of sections) {
    if (!kinds.includes(s.kind)) continue;
    for (let i = 0; i < s.lines.length; i++) {
      const line = s.lines[i]!;
      const hay = normalizeForMatch(isBulletLine(line) ? bulletText(line) : line);
      if (hay && (hay.startsWith(needle) || needle.startsWith(hay))) {
        return { section: s.title || s.kind, line: s.lineNos[i] ?? i + 1, text: line };
      }
    }
  }
  return null;
}

/** "Queue Lens — open-source Kafka dashboard (TypeScript)" → name + the description part. */
function splitProjectHeader(line: string): { name: string; desc: string } {
  const range = findDateRange(line);
  let l = range ? `${line.slice(0, range.index)}${line.slice(range.index + range.raw.length)}`.trim() : line;
  l = l.replace(/\s*(?:\||[–—-])?\s*(?:19|20)\d{2}\s*$/, "").trim();
  const m = /^(.{2,60}?)\s*(?:\s[—–-]\s|:\s|\s\|\s)\s*(.+)$/.exec(l);
  if (m) {
    const parts = m[2]!.split(/\s\|\s/);
    return { name: m[1]!.trim(), desc: parts.find((p) => p.split(/\s+/).length > 2)?.trim() ?? "" };
  }
  return { name: l.replace(/[|–—-]+\s*$/, "").trim(), desc: "" };
}

export interface DraftEvidenceInput {
  roles: ResumeRole[];
  sections: ResumeSectionBlock[];
  origin?: EvidenceOrigin;
}

export function draftEvidence({ roles, sections, origin = "resume" }: DraftEvidenceInput): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  for (const r of roles) {
    const bullets = r.bullets.map((b) => b.trim()).filter(Boolean);
    if (!bullets.length) continue;
    const [headline, ...rest] = bullets;
    out.push({
      project: r.company || r.title,
      headline: headline!,
      detail: rest.join("\n"),
      metric: metricOf(bullets),
      tags: extractSkills(bullets.join("\n")),
      origin,
      span: spanFor(sections, headline!, ["experience"]),
      selected: true,
    });
  }

  // projects: a non-bullet header line starts a project; its bullets follow
  for (const s of sections) {
    if (s.kind !== "projects") continue;
    let cur: { header: string; bullets: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const { name, desc } = splitProjectHeader(cur.header);
      // the one-line description leads (it says what the project IS), bullets follow
      const claims = desc ? [desc, ...cur.bullets] : cur.bullets;
      if (claims.length && name) {
        const [headline, ...rest] = claims;
        out.push({
          project: name,
          headline: headline!,
          detail: rest.join("\n"),
          metric: metricOf([cur.header, ...cur.bullets]),
          tags: extractSkills([cur.header, ...cur.bullets].join("\n")),
          origin,
          span: spanFor(sections, desc ? cur.header : headline!, ["projects"]),
          selected: true,
        });
      }
      cur = null;
    };
    for (const line of s.lines) {
      if (isBulletLine(line)) {
        const b = bulletText(line);
        if (cur) cur.bullets.push(b);
        else {
          // a bulleted project list with no headers: each bullet is its own project line
          cur = { header: b, bullets: [] };
          flush();
        }
      } else if (cur && cur.bullets.length && /^[a-z(&,]/.test(line)) {
        cur.bullets[cur.bullets.length - 1] += ` ${line}`;
      } else if (cur && !cur.bullets.length && !splitProjectHeader(cur.header).desc && !splitProjectHeader(line).desc && !findDateRange(line)) {
        // "Queue Lens" then its one-line description underneath
        cur.bullets.push(line);
      } else {
        flush();
        cur = { header: line, bullets: [] };
      }
    }
    flush();
  }
  return out;
}
