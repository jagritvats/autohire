import { httpJson } from "@jobflow/adapters";

/**
 * Profile-source importers (§ Customize "connected context"). Pure-ish functions that
 * turn an external source into a read-only context block for generation. GitHub is
 * Tier-1 (public API, cloud-safe). LinkedIn is a user-uploaded data-export (no
 * scraping). YC is auth-gated → imported by the LOCAL agent (or pasted), never here.
 *
 * They return only the renderable payload; the caller wraps it into a ConnectedContext
 * (id/tenantId/enabled/syncedAt) and persists it.
 */
export interface ImportedContext {
  handle: string;
  label: string;
  content: string;
  items: Record<string, unknown>[];
}

// ── GitHub (Tier 1, cloud-safe) ──
interface GhUser {
  login: string;
  name: string | null;
  bio: string | null;
  html_url: string;
  public_repos: number;
  followers: number;
}
interface GhRepo {
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  topics?: string[];
  fork: boolean;
  archived: boolean;
  html_url: string;
}

export async function importGithub(handle: string, token = process.env.GITHUB_TOKEN): Promise<ImportedContext> {
  const h = handle.replace(/^@/, "").trim();
  if (!h) throw new Error("GitHub handle required");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const user = await httpJson<GhUser>(`https://api.github.com/users/${encodeURIComponent(h)}`, { headers });
  if (!user) throw new Error(`GitHub user '${h}' not found (or rate-limited — set GITHUB_TOKEN).`);
  const repos =
    (await httpJson<GhRepo[]>(
      `https://api.github.com/users/${encodeURIComponent(h)}/repos?per_page=100&sort=pushed&type=owner`,
      { headers },
    )) ?? [];

  const top = repos
    .filter((r) => !r.fork && !r.archived)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 12);
  const items = top.map((r) => ({
    name: r.name,
    language: r.language ?? "",
    stars: r.stargazers_count,
    description: r.description ?? "",
    topics: r.topics ?? [],
    url: r.html_url,
  }));
  const languages = [...new Set(top.map((r) => r.language).filter((l): l is string => !!l))];

  const lines: string[] = [];
  lines.push(`GitHub @${user.login}${user.name ? ` (${user.name})` : ""}${user.bio ? ` — ${user.bio}` : ""}`);
  lines.push(`Public repos: ${user.public_repos} · followers: ${user.followers}`);
  if (top.length) {
    lines.push("Top repositories:");
    for (const r of top) {
      const tags = r.topics?.length ? ` [${r.topics.slice(0, 6).join(", ")}]` : "";
      lines.push(`- ${r.name} (${r.language ?? "—"}, ★${r.stargazers_count})${r.description ? `: ${r.description}` : ""}${tags}`);
    }
  }
  if (languages.length) lines.push(`Languages observed: ${languages.join(", ")}`);

  return { handle: user.login, label: `github.com/${user.login}`, content: lines.join("\n"), items };
}

// ── LinkedIn data-export (server-safe — the user uploads their own CSVs) ──
export function parseLinkedinFiles(files: { name: string; text: string }[]): ImportedContext {
  const byName = (needle: string) => files.find((f) => f.name.toLowerCase().includes(needle));
  const positions = byName("position");
  const skills = byName("skill");
  const profile = byName("profile");

  const items: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let headline = "";

  if (profile) {
    const rows = parseCsv(profile.text);
    const row = rows[0];
    if (row) {
      headline = row["Headline"] ?? "";
      if (headline) lines.push(`LinkedIn — ${headline}`);
      const summary = (row["Summary"] ?? "").trim();
      if (summary) lines.push(`Summary: ${summary.slice(0, 800)}`);
    }
  }
  if (!lines.length) lines.push("LinkedIn export");

  if (positions) {
    const rows = parseCsv(positions.text);
    if (rows.length) lines.push("Experience:");
    for (const r of rows.slice(0, 12)) {
      const title = r["Title"] ?? "";
      const company = r["Company Name"] ?? r["Company"] ?? "";
      const start = r["Started On"] ?? "";
      const end = r["Finished On"] ?? "Present";
      const desc = (r["Description"] ?? "").replace(/\s+/g, " ").trim();
      if (!title && !company) continue;
      items.push({ title, company, start, end, description: desc });
      lines.push(`- ${title}${company ? ` @ ${company}` : ""} (${start}${start ? "–" : ""}${end})${desc ? `: ${desc.slice(0, 300)}` : ""}`);
    }
  }
  if (skills) {
    const rows = parseCsv(skills.text);
    const names = rows.map((r) => r["Name"] ?? Object.values(r)[0] ?? "").filter(Boolean);
    if (names.length) lines.push(`Skills: ${names.slice(0, 40).join(", ")}`);
  }

  if (items.length === 0 && !skills && !profile) {
    throw new Error("No LinkedIn data recognised. Upload Positions.csv / Skills.csv / Profile.csv from your export.");
  }
  return { handle: "export", label: headline ? `LinkedIn — ${headline}` : "LinkedIn export", content: lines.join("\n"), items };
}

/** Minimal RFC-4180-ish CSV parser → array of row objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0]!;
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => (obj[h] = r[i] ?? ""));
    return obj;
  });
}
