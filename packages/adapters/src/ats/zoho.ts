import type { RawPosting } from "@jobflow/core";
import { DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Zoho Recruit career sites (Tier 2: the public JSON the career page calls, no auth) —
 * Indian SaaS/services firms (Wissen, Yellow.ai, Ultrahuman, Bruno…). slug = the career
 * site HOST, which may be a custom domain ("careers.yellow.ai") or "{c}.zohorecruit.in".
 * Verified live 2026-09:
 *   GET https://{host}/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite
 *   GET https://{host}/recruit/v2/public/Job_Openings/{id}?pagename=Careers&source=CareerSite
 * The list JD is often cut at ~150 chars, so NEW postings get the detail call. Closed
 * jobs can stay listed — only `Publish === true` counts. `Date_Opened` is date-only and
 * recruiter-editable; list format is MM/dd/yyyy, detail ISO.
 */

interface ZohoJob {
  id: string;
  Posting_Title?: string;
  Job_Opening_Name?: string;
  Job_Description?: string;
  City?: string;
  State?: string;
  Country?: string;
  Remote_Job?: boolean;
  Publish?: boolean;
  Date_Opened?: string;
  Work_Experience?: string | null;
  Work_Experience_Min?: number | string | null;
  Work_Experience_Max?: number | string | null;
  $url?: string;
}
interface ZohoList {
  data?: ZohoJob[];
}

export class ZohoRecruitAdapter implements SourceAdapter {
  readonly source = "zoho" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const host = target.slug?.replace(/^https?:\/\//, "").split("/")[0];
    if (!host) return [];
    const base = `https://${host}/recruit/v2/public/Job_Openings`;
    const qs = "pagename=Careers&source=CareerSite";
    const list = await httpJson<ZohoList>(`${base}?${qs}`);
    if (!list) return [];
    const jobs = (list.data ?? []).filter((j) => j.Publish !== false);

    const needDetail = pickForDetail(jobs.filter((j) => !target.known?.has(j.id)), (j) => j.Posting_Title ?? j.Job_Opening_Name ?? "", target.limit ?? DETAIL_CAP);
    const details = new Map<string, ZohoJob>();
    await mapPool(needDetail, 3, async (j) => {
      const d = await httpJson<ZohoList | ZohoJob>(`${base}/${j.id}?${qs}`);
      const job = d && "data" in d ? d.data?.[0] : (d as ZohoJob | null);
      if (job) details.set(j.id, job);
    });

    return jobs.map((l) => {
      const j = { ...l, ...details.get(l.id) };
      const place = [j.City, j.State, j.Country].filter(Boolean).join(", ");
      const exp =
        j.Work_Experience_Min != null && j.Work_Experience_Min !== ""
          ? `Experience: ${j.Work_Experience_Min}${j.Work_Experience_Max != null && j.Work_Experience_Max !== "" ? `-${j.Work_Experience_Max}` : "+"} years\n`
          : j.Work_Experience
            ? `Experience: ${j.Work_Experience}\n`
            : "";
      return {
        source: "zoho",
        tier: "tier2",
        atsType: "zoho",
        atsJobId: j.id,
        companyName: host.split(".")[0] === "careers" ? host.split(".")[1] ?? host : host.split(".")[0] ?? host,
        companySlug: host,
        title: (j.Posting_Title ?? j.Job_Opening_Name ?? "").trim(),
        jdText: details.has(l.id) ? `${exp}${htmlToText(j.Job_Description)}` : "",
        jdHtml: details.has(l.id) ? j.Job_Description ?? null : null,
        locationRaw: `${j.Remote_Job ? "Remote - " : ""}${place}` || null,
        applyUrl: j.$url ?? `https://${host}/jobs/Careers/${j.id}`,
        salaryRaw: null,
        postedAt: zohoDate(j.Date_Opened),
        experienceHint: zohoExperience(j.Work_Experience_Min, j.Work_Experience_Max),
        fetchedAt: new Date(),
        raw: { id: j.id } as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}

/** "08/05/2026" (MM/dd/yyyy, list) or "2026-08-05" (detail) → ISO. */
function zohoDate(s: string | undefined): string | null {
  if (!s) return null;
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const d = us ? new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]))) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Work_Experience_Min/Max come as numbers or numeric strings (years); anything else → no hint. */
function zohoExperience(min: unknown, max: unknown): { min: number; max: number | null } | undefined {
  const lo = Number(min);
  const hi = Number(max);
  if (min == null || min === "" || !Number.isFinite(lo)) return undefined;
  return { min: lo, max: max != null && max !== "" && Number.isFinite(hi) && hi >= lo ? hi : null };
}
