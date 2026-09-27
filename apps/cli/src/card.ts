import { postingAgeDays, type Match, type Posting } from "@jobflow/core";

/** Render the §11.6 match card — the actual product surface. */
export function renderMatchCard(m: Match & { posting: Posting }, idx: number): string {
  const p = m.posting;
  const loc = locationLine(p);
  const fresh = freshnessLine(p);
  const comp = compLine(p);
  const company = companyLine(p);

  const lines: string[] = [];
  lines.push(bold(`${pad(idx)}. ${p.title} · ${p.companyName} · ${loc}`));
  lines.push(`    Match ${scoreBadge(m.score)}  ·  ${fresh}  ·  ${p.source}`);
  if (p.jdSkills.length) {
    lines.push(`    Stack:  ${p.jdSkills.slice(0, 8).join(", ")}`);
  }
  if (m.stackNote) lines.push(`    Fit:    ${m.stackNote}`);
  if (m.levelNote) lines.push(`    Level:  ${m.levelNote}`);
  if (comp) lines.push(`    Comp:   ${comp}`);
  if (company) lines.push(`    Company:${company}`);
  if (m.redFlags.length) lines.push(`    Watch:  ${m.redFlags.join(" · ")}`);
  if (p.applyUrl) lines.push(`    Apply:  ${p.applyUrl}`);
  return lines.join("\n");
}

function locationLine(p: Posting): string {
  const l = p.location;
  if (l.mode === "remote") return `Remote (${l.remoteGeo})`;
  const where = [l.city, l.country].filter(Boolean).join(", ");
  return `${cap(l.mode)}${where ? ` · ${where}` : ""}`;
}

function freshnessLine(p: Posting): string {
  const ageDays = Math.floor(postingAgeDays(p)); // source publish date, else first seen
  const tag = p.atsType !== "unknown" ? "ATS-direct" : "aggregator";
  const age = ageDays <= 0 ? "today" : `${ageDays}d`;
  return `${p.postedAt ? "Posted" : "Seen"} ${age} ago (${tag})`;
}

function compLine(p: Posting): string | null {
  const s = p.salary;
  if (s.min == null && s.max == null) return null;
  const range =
    s.min != null && s.max != null
      ? `${fmt(s.min, s.currency)}–${fmt(s.max, s.currency)}`
      : `${fmt((s.min ?? s.max)!, s.currency)}+`;
  return `est. ${range} (${s.confidence} · ${s.source})`;
}

function companyLine(p: Posting): string | null {
  // enrichment (ratings) is gated on match score & runs later; show nothing if absent
  return null;
}

function fmt(n: number, cur: string): string {
  if (cur === "INR") return `₹${(n / 100000).toFixed(0)}L`;
  if (cur === "USD") return `$${Math.round(n / 1000)}k`;
  return `${Math.round(n / 1000)}k ${cur}`;
}

function scoreBadge(s: number): string {
  const c = s >= 80 ? "\x1b[32m" : s >= 60 ? "\x1b[33m" : "\x1b[90m";
  return `${c}${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function pad(n: number): string {
  return String(n).padStart(2, " ");
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
