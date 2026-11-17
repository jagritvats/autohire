import type { Contact } from "../schema/entities.js";
import type { ResumeDraft, ResumeRole } from "../schema/resume.js";
import { parseTitle } from "../normalize/titles.js";
import { matchSkillToken } from "../normalize/skills.js";
import { parseCsvRecords } from "./csv.js";
import { parseDateToken } from "./dates.js";
import { bareUrl } from "./contact.js";
import { buildDraft } from "./parse.js";

/**
 * Structured imports — JSON Resume (jsonresume.org) and a LinkedIn data export. Both are
 * rendered to plain résumé text (which becomes `masterResume`, the grounding source) and
 * run through the same parser as an uploaded file, with the structured roles and contact
 * fields taken as-is instead of re-parsed. Fields are copied, never composed.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2023-01" → "Jan 2023", "2023" → "2023". */
function displayDate(d: string | null): string {
  if (!d) return "";
  const [y, m] = d.split("-");
  return m ? `${MON[Number(m) - 1] ?? ""} ${y}`.trim() : (y ?? "");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function makeRole(title: string, company: string, startRaw: string, endRaw: string, bullets: string[]): ResumeRole {
  const start = startRaw ? parseDateToken(startRaw.slice(0, 7)) ?? parseDateToken(startRaw) : null;
  const end = endRaw ? parseDateToken(endRaw.slice(0, 7)) ?? parseDateToken(endRaw) : null;
  const current = !!start && !endRaw.trim();
  const t = parseTitle(title);
  return { title, company, start, end: current ? null : end, current, bullets, levelBand: t.levelBand, archetype: t.roleArchetype };
}

function roleLine(r: ResumeRole): string {
  const when = r.start ? ` — ${displayDate(r.start)} – ${r.current ? "Present" : displayDate(r.end) || "Present"}` : "";
  return `${[r.title, r.company].filter(Boolean).join(", ")}${when}`;
}

/** Description paragraphs → bullet claims (one per line / glyph bullet), verbatim. */
function descriptionBullets(desc: string): string[] {
  return desc
    .split(/\r?\n|(?:^|\s)[•▪●◦]\s+/)
    .map((s) => s.replace(/^\s*[-*•–]\s+/, "").trim())
    .filter(Boolean);
}

interface RenderParts {
  name: string;
  headline: string;
  contactBits: string[];
  location: string;
  summary: string;
  roles: ResumeRole[];
  projects: Array<{ name: string; description: string; bullets: string[] }>;
  skills: string[];
  education: string[];
  other: Array<{ title: string; lines: string[] }>;
}

function render(p: RenderParts): string {
  const out: string[] = [];
  if (p.name) out.push(p.name);
  if (p.headline) out.push(p.headline);
  if (p.contactBits.length) out.push(p.contactBits.join(" | "));
  if (p.location) out.push(p.location);
  if (p.summary) out.push("", "Summary", p.summary);
  if (p.roles.length) {
    out.push("", "Experience");
    for (const r of p.roles) {
      out.push(roleLine(r));
      for (const b of r.bullets) out.push(`- ${b}`);
    }
  }
  if (p.projects.length) {
    out.push("", "Projects");
    for (const pr of p.projects) {
      out.push(pr.description ? `${pr.name} — ${pr.description}` : pr.name);
      for (const b of pr.bullets) out.push(`- ${b}`);
    }
  }
  if (p.skills.length) out.push("", "Skills", ...p.skills);
  if (p.education.length) out.push("", "Education", ...p.education);
  for (const o of p.other) if (o.lines.length) out.push("", o.title, ...o.lines);
  return out.join("\n");
}

function withContact(d: ResumeDraft, c: Partial<Contact>): ResumeDraft {
  const contact = { ...d.contact };
  for (const [k, v] of Object.entries(c) as Array<[keyof Contact, string | undefined]>) if (v) contact[k] = v;
  return { ...d, contact, warnings: d.warnings.filter((w) => !(contact.email && /^No email/.test(w)) && !(contact.firstName && /your name/.test(w))) };
}

function splitName(name: string): Partial<Contact> {
  const [first, ...rest] = name.trim().split(/\s+/);
  return first ? { firstName: first, lastName: rest.join(" ") } : {};
}

// ── JSON Resume ──

export function jsonResumeToDraft(json: unknown, opts: { now?: Date } = {}): ResumeDraft {
  const root = obj(json);
  const basics = obj(root.basics);
  const loc = obj(basics.location);
  const contact: Partial<Contact> = { ...splitName(str(basics.name)) };
  if (str(basics.email)) contact.email = str(basics.email);
  if (str(basics.phone)) contact.phone = str(basics.phone);
  const bits: string[] = [contact.email ?? "", contact.phone ?? ""];
  if (str(basics.url) || str(basics.website)) {
    contact.portfolio = bareUrl(str(basics.url) || str(basics.website));
    bits.push(contact.portfolio);
  }
  for (const pr of arr(basics.profiles).map(obj)) {
    const network = str(pr.network).toLowerCase();
    const url = str(pr.url);
    const user = str(pr.username);
    if (network.includes("linkedin")) contact.linkedin = url ? bareUrl(url) : user ? `linkedin.com/in/${user}` : "";
    else if (network.includes("github")) contact.github = url ? bareUrl(url) : user ? `github.com/${user}` : "";
    else continue;
    const v = network.includes("linkedin") ? contact.linkedin : contact.github;
    if (v) bits.push(v);
  }

  const roles = arr(root.work).map(obj).map((w) => {
    const bullets = [str(w.summary), ...arr(w.highlights).map(str)].filter(Boolean);
    return makeRole(str(w.position), str(w.name) || str(w.company), str(w.startDate), str(w.endDate), bullets);
  });
  const projects = arr(root.projects).map(obj).map((p) => ({
    name: str(p.name),
    description: str(p.description),
    bullets: arr(p.highlights).map(str).filter(Boolean),
  })).filter((p) => p.name);
  const skills = arr(root.skills).map(obj).map((s) => {
    const name = str(s.name);
    const kws = arr(s.keywords).map(str).filter(Boolean);
    if (!kws.length) return name;
    // "Backend: Java, Go" — but a skill-named group ("Java") is itself an entry
    return matchSkillToken(name) ? [name, ...kws].join(", ") : `${name}: ${kws.join(", ")}`;
  }).filter(Boolean);
  const education = arr(root.education).map(obj).map((e) => {
    const what = [str(e.studyType), str(e.area)].filter(Boolean).join(" ");
    const when = [str(e.startDate).slice(0, 4), str(e.endDate).slice(0, 4)].filter(Boolean).join(" – ");
    return [what, str(e.institution)].filter(Boolean).join(", ") + (when ? ` — ${when}` : "");
  }).filter(Boolean);
  const certs = arr(root.certificates).map(obj).map((c) => [str(c.name), str(c.issuer)].filter(Boolean).join(" — ")).filter(Boolean);

  const location = [str(loc.city), str(loc.region) || str(loc.countryCode)].filter(Boolean).join(", ");
  const text = render({
    name: str(basics.name),
    headline: str(basics.label),
    contactBits: bits.filter(Boolean),
    location,
    summary: str(basics.summary),
    roles,
    projects,
    skills,
    education,
    other: [{ title: "Certifications", lines: certs }],
  });
  const draft = withContact(buildDraft(text, { format: "json_resume", now: opts.now, roles }), contact);
  return {
    ...draft,
    headline: str(basics.label) || draft.headline,
    locations: location ? [location] : draft.locations,
    warnings: Object.keys(basics).length ? draft.warnings : ["No `basics` block — is this a JSON Resume file?", ...draft.warnings],
  };
}

// ── LinkedIn data export ──

/**
 * LinkedIn "Get a copy of your data" export: Profile.csv, Positions.csv, Skills.csv (+
 * Email Addresses.csv, Projects.csv, Education.csv when present). The user uploads their
 * own files — nothing is fetched from LinkedIn (invariant #1).
 */
export function linkedinToDraft(files: Array<{ name: string; text: string }>, opts: { now?: Date } = {}): ResumeDraft {
  const find = (re: RegExp) => files.find((f) => re.test(f.name.split("/").pop() ?? f.name));
  const rows = (re: RegExp) => {
    const f = find(re);
    return f ? parseCsvRecords(f.text) : [];
  };
  const profile = rows(/^profile\.csv$/i)[0] ?? {};
  const emails = rows(/^email addresses\.csv$/i);
  const positions = rows(/^positions\.csv$/i);
  const skillRows = rows(/^skills\.csv$/i);
  const projectRows = rows(/^projects\.csv$/i);
  const eduRows = rows(/^education\.csv$/i);

  const name = [profile["First Name"], profile["Last Name"]].filter(Boolean).join(" ");
  const contact: Partial<Contact> = { ...splitName(name) };
  const email = emails.find((e) => /yes/i.test(e["Primary"] ?? "")) ?? emails[0];
  if (email?.["Email Address"]) contact.email = email["Email Address"];
  const websites = (profile["Websites"] ?? "").match(/https?:\/\/[^\s,\]]+/g) ?? [];
  const bits: string[] = [contact.email ?? ""];
  for (const w of websites) {
    const b = bareUrl(w);
    if (/github\.com\//i.test(b)) contact.github ??= b.split("/").slice(0, 2).join("/");
    else if (!/linkedin\.com/i.test(b)) contact.portfolio ??= b;
    bits.push(b);
  }

  const roles = positions
    .map((p) => makeRole(p["Title"] ?? "", p["Company Name"] ?? p["Company"] ?? "", p["Started On"] ?? "", p["Finished On"] ?? "", descriptionBullets(p["Description"] ?? "")))
    .filter((r) => r.title || r.company);
  const projects = projectRows
    .map((p) => {
      const bullets = descriptionBullets(p["Description"] ?? "");
      return { name: p["Title"] ?? "", description: bullets.length === 1 ? bullets[0]! : "", bullets: bullets.length > 1 ? bullets : [] };
    })
    .filter((p) => p.name);
  const skillNames = skillRows.map((r) => r["Name"] ?? Object.values(r)[0] ?? "").filter(Boolean);
  const education = eduRows
    .map((e) => {
      const when = [e["Start Date"], e["End Date"]].filter(Boolean).join(" – ");
      return [e["Degree Name"], e["School Name"]].filter(Boolean).join(", ") + (when ? ` — ${when}` : "");
    })
    .filter(Boolean);

  const text = render({
    name,
    headline: profile["Headline"] ?? "",
    contactBits: bits.filter(Boolean),
    location: profile["Geo Location"] ?? profile["Location"] ?? "",
    summary: (profile["Summary"] ?? "").replace(/\s*\n\s*/g, " ").trim(),
    roles,
    projects,
    skills: skillNames.length ? [skillNames.join(", ")] : [],
    education,
    other: [],
  });
  const draft = withContact(buildDraft(text, { format: "linkedin", now: opts.now, roles }), contact);
  const warnings = [...draft.warnings];
  if (!positions.length) warnings.unshift("No Positions.csv found in the export — roles are empty.");
  if (!files.length) warnings.unshift("No files in the LinkedIn export.");
  const geo = profile["Geo Location"] ?? profile["Location"] ?? "";
  return { ...draft, headline: profile["Headline"] || draft.headline, locations: geo ? [geo] : draft.locations, warnings };
}
