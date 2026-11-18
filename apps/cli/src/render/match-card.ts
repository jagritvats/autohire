import { describeLocation, describePay, postingAgeDays, type Match, type Posting } from "@jobflow/core";

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

/** the same plain-language line the feed cards use (`describeLocation`) */
function locationLine(p: Posting): string {
  return describeLocation(p.location).label;
}

function freshnessLine(p: Posting): string {
  const ageDays = Math.floor(postingAgeDays(p)); // source publish date, else first seen
  const tag = p.atsType !== "unknown" ? "ATS-direct" : "aggregator";
  const age = ageDays <= 0 ? "today" : `${ageDays}d`;
  return `${p.postedAt ? "Posted" : "Seen"} ${age} ago (${tag})`;
}

function compLine(p: Posting): string | null {
  // core's one pay formatter (period, currency, estimate labelling)
  const pay = describePay(p);
  if (!pay) return null;
  if (!pay.estimate) return `${pay.label} (stated · ${pay.confidence})${pay.warning ? ` — ${pay.warning}` : ""}`;
  return `${pay.label} (${Math.round((pay.confidenceScore ?? 0) * 100)}% · ${pay.basis})`;
}

function companyLine(p: Posting): string | null {
  // enrichment (ratings) is gated on match score & runs later; show nothing if absent
  return null;
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
