import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpStatus, httpText, liveFromStatus, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";
import { xmlText } from "../feeds/xml.js";

/**
 * Teamtailor career sites (Tier 1: the public RSS feed every career site publishes, no
 * auth) — Nordic/EU scale-ups (Lunar, Polestar, Oatly, Tibber…). Teamtailor's JSON:API
 * needs a per-company API key, so the RSS is the public route. Verified live 2026-11:
 *   GET https://{slug}.teamtailor.com/jobs.rss   → every published job, JD inline (not paged:
 *       46 items on a 46-job site), <tt:locations>, <remoteStatus>, <pubDate>
 *   GET https://{host}/jobs/{id}                 → 404 once removed (a teamtailor.com URL
 *       301s to the company's own domain first, so redirects are followed)
 * Many sites live on the company's own domain (jobs.lunar.app) and serve the same feed
 * there. slug = the subdomain ("lunar") or, for a custom domain, the host.
 */

export interface TeamtailorItem {
  title: string;
  link: string;
  guid: string;
  description: string;
  pubDate: string | null;
  remoteStatus: string;
  department: string;
  locations: Array<{ name: string; city: string; country: string }>;
}

export class TeamtailorAdapter implements SourceAdapter {
  readonly source = "teamtailor" as const;
  readonly tier = "tier1" as const;

  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const host = teamtailorHost(job.slug);
    if (!host || !/^\d+$/.test(job.jobId)) return null;
    return liveFromStatus(await httpStatus(`https://${host}/jobs/${job.jobId}`, { redirect: "follow", headers: { Accept: "text/html" } }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const host = teamtailorHost(target.slug);
    if (!host) return [];
    const xml = await httpText(`https://${host}/jobs.rss`, { headers: { Accept: "application/rss+xml, application/xml" } });
    if (!xml || !/<rss\b/.test(xml)) return [];
    const company = xmlText(xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? "") || host.split(".")[0]!;
    return parseTeamtailorItems(parseTeamtailorRss(xml), host, company);
  }
}

/** "lunar" → lunar.teamtailor.com; "jobs.lunar.app" (a custom domain) stays as is. */
export function teamtailorHost(s: string | null | undefined): string | null {
  const raw = (s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (/^[a-z0-9-]+$/.test(raw)) return `${raw}.teamtailor.com`;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
}

export function parseTeamtailorRss(xml: string): TeamtailorItem[] {
  const field = (b: string, tag: string) => xmlText(b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
  const items: TeamtailorItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1]!;
    const locations = [...b.matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)].map((l) => ({
      name: field(l[1]!, "tt:name"),
      city: field(l[1]!, "tt:city"),
      country: field(l[1]!, "tt:country"),
    }));
    items.push({
      title: field(b, "title"),
      link: field(b, "link"),
      guid: field(b, "guid"),
      description: field(b, "description"),
      pubDate: field(b, "pubDate") || null,
      remoteStatus: field(b, "remoteStatus"),
      department: field(b, "tt:department"),
      locations,
    });
  }
  return items;
}

/** RSS items → RawPostings (pure; exported for fixture tests). */
export function parseTeamtailorItems(items: TeamtailorItem[], host: string, company: string): RawPosting[] {
  const slug = host.endsWith(".teamtailor.com") ? host.split(".")[0]! : host;
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const it of items) {
    // the numeric id in /jobs/{id}-{slug} is stable and is what the job page is keyed on
    const id = it.link.match(/\/jobs\/(\d+)/)?.[1] ?? it.guid;
    if (!id || !it.title || seen.has(id)) continue;
    seen.add(id);
    const places = [...new Set(it.locations.map((l) => l.name || [l.city, l.country].filter(Boolean).join(", ")).filter(Boolean))];
    // remoteStatus: none | onsite | hybrid | fully ("temporary" on older sites)
    const mode = it.remoteStatus === "fully" ? "Remote - " : it.remoteStatus === "hybrid" ? "Hybrid - " : "";
    const t = it.pubDate ? Date.parse(it.pubDate) : NaN;
    out.push({
      source: "teamtailor",
      tier: "tier1",
      atsType: "teamtailor",
      atsJobId: id,
      companyName: company,
      companySlug: slug,
      title: it.title.trim(),
      jdText: htmlToText(it.description),
      jdHtml: it.description || null,
      locationRaw: places.length ? `${mode}${places.join("; ")}` : it.remoteStatus === "fully" ? "Remote" : null,
      applyUrl: it.link || null,
      salaryRaw: null,
      postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      fetchedAt: new Date(),
      raw: { id, guid: it.guid, department: it.department, remoteStatus: it.remoteStatus } as Record<string, unknown>,
    });
  }
  return out;
}
