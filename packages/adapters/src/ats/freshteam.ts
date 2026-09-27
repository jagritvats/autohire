import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpText, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Freshteam (Tier 2: the careers-widget JSON, no auth) — Freshworks' ATS, used by
 * Indian startups (Everstage, Locus…). slug = the {sub}.freshteam.com subdomain.
 * Verified live 2026-09:
 *   GET https://{sub}.freshteam.com/hire/widgets/jobs.json → {jobs[], branches[], job_roles[]}
 * JD inline; `created_at` is the true creation date (never refreshed — can be years
 * old, which the freshness score then reflects honestly). A deleted account answers
 * 200 text/html, so the content is checked, not just the status.
 */

interface FtJob {
  id: number;
  title: string;
  description?: string;
  created_at?: string;
  closing_date?: string | null;
  remote?: boolean;
  branch_id?: number;
  unique_id?: string;
  status?: string;
  deleted?: boolean;
  show_position_in_portal?: boolean;
}
interface FtBranch {
  id: number;
  city?: string;
  state?: string;
  country_code?: string;
}
interface FtWidget {
  jobs?: FtJob[];
  branches?: FtBranch[];
}

const COUNTRY_BY_CODE: Record<string, string> = { IN: "India", US: "United States", GB: "United Kingdom", SG: "Singapore" };

export class FreshteamAdapter implements SourceAdapter {
  readonly source = "freshteam" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const sub = target.slug?.replace(/[^a-z0-9-]/gi, "");
    if (!sub) return [];
    const body = await httpText(`https://${sub}.freshteam.com/hire/widgets/jobs.json`, { headers: { Accept: "application/json" } });
    let widget: FtWidget | null = null;
    try {
      widget = body && body.trimStart().startsWith("{") ? (JSON.parse(body) as FtWidget) : null;
    } catch {
      widget = null;
    }
    if (!widget?.jobs) return [];
    const branches = new Map((widget.branches ?? []).map((b) => [b.id, b]));

    return widget.jobs
      .filter((j) => !j.deleted && (!j.closing_date || new Date(j.closing_date).getTime() > Date.now()))
      .map((j) => {
        const b = j.branch_id != null ? branches.get(j.branch_id) : undefined;
        const place = [b?.city, b?.state?.trim(), b?.country_code ? COUNTRY_BY_CODE[b.country_code] ?? b.country_code : null]
          .filter(Boolean)
          .join(", ");
        const slugTitle = j.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return {
          source: "freshteam",
          tier: "tier2",
          atsType: "freshteam",
          atsJobId: String(j.id),
          companyName: sub,
          companySlug: sub,
          title: j.title.trim(),
          jdText: htmlToText(j.description),
          jdHtml: j.description ?? null,
          locationRaw: `${j.remote ? "Remote - " : ""}${place}` || null,
          applyUrl: j.unique_id ? `https://${sub}.freshteam.com/jobs/${j.unique_id}/${slugTitle}` : null,
          salaryRaw: null,
          postedAt: j.created_at ?? null,
          fetchedAt: new Date(),
          raw: { id: j.id } as Record<string, unknown>,
        } satisfies RawPosting;
      });
  }
}
