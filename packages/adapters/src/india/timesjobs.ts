import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * TimesJobs (Tier 2: the JSON its own search page calls, no auth). Its value is the
 * detail call's `externalJobsLink`, which points STRAIGHT at the company's own posting
 * (Greenhouse/Lever/SmartRecruiters/Keka/careers pages) — so a TimesJobs hit doubles as
 * discovery: the apply link resolves the employer's board. Verified live 2026-09:
 *   POST https://tjapi.timesjobs.com/search/api/v1/search/jobs/list   (JSON body below)
 *   GET  https://tjapi.timesjobs.com/job-api/api/jobs/public/{jobId}   (JD + external link)
 * `experience` filters server-side to ranges containing that many years; multi-word
 * keywords are OR-matched, so feeds use single words. `postDate` is when TimesJobs
 * picked the job up (lags the ATS date by 1–13 days). ~39% of results are IT services.
 */

const LOCATIONS =
  "Bengaluru,Hyderabad/Secunderabad,Pune,Gurugram,Noida/Greater Noida,Mumbai,Chennai,Remote,India,Delhi,Navi Mumbai";

interface TjListJob {
  jobId: string;
  title: string;
  company?: string;
  location?: string;
  experienceFrom?: number;
  experienceTo?: number;
  postDate?: string;
  skills?: string;
  description?: string;
  jobDetailUrl?: string;
}
interface TjList {
  jobs?: TjListJob[];
  totalPages?: number;
}
interface TjDetail {
  description?: string;
  minExperience?: number;
  maxExperience?: number;
  postedAt?: string;
  externalJobsLink?: string | null;
  locationNames?: string[];
  companyName?: string;
}

export class TimesJobsAdapter implements SourceAdapter {
  readonly source = "timesjobs" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const limit = target.limit ?? 60;
    const jobs: TjListJob[] = [];
    for (let page = 1; jobs.length < limit && page <= 5; page++) {
      const body = {
        keyword: target.query ?? "backend",
        location: String(target.params?.locations ?? LOCATIONS),
        experience: String(target.params?.experience ?? ""),
        functionAreaId: "",
        company: "",
        jobFunction: String(target.params?.jobFunction ?? "IT Software : Software Products & Services"),
        industry: "",
        size: "100",
        page: String(page),
      };
      const res = await httpJson<TjList>("https://tjapi.timesjobs.com/search/api/v1/search/jobs/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
      const batch = res?.jobs ?? [];
      jobs.push(...batch);
      if (batch.length < 100 || page >= (res?.totalPages ?? 1)) break;
    }
    const top = jobs.slice(0, limit);

    const details = new Map<string, TjDetail | null>();
    await mapPool(top, 3, async (j) =>
      details.set(j.jobId, await httpJson<TjDetail>(`https://tjapi.timesjobs.com/job-api/api/jobs/public/${j.jobId}`)),
    );

    return top.map((j) => {
      const d = details.get(j.jobId);
      const lo = d?.minExperience ?? j.experienceFrom;
      const hi = d?.maxExperience ?? j.experienceTo;
      const exp = lo != null && lo >= 0 ? `Experience: ${lo}${hi != null && hi > lo ? `-${hi}` : "+"} years\n` : "";
      const skills = j.skills ? `\nSkills: ${j.skills}` : "";
      const places = d?.locationNames?.length ? d.locationNames.join("; ") : j.location ?? "";
      return {
        source: "timesjobs",
        tier: "tier2",
        atsType: "unknown",
        atsJobId: j.jobId,
        companyName: (d?.companyName ?? j.company ?? "Unknown").trim(),
        companySlug: null,
        title: j.title.trim(),
        jdText: `${exp}${htmlToText(d?.description) || j.description || ""}${skills}`,
        jdHtml: d?.description ?? null,
        locationRaw: places ? `${places}${/india/i.test(places) ? "" : ", India"}` : "India",
        // the employer's own posting when TimesJobs has it — trust + board discovery
        applyUrl: d?.externalJobsLink || j.jobDetailUrl || null,
        salaryRaw: null,
        postedAt: j.postDate ?? d?.postedAt ?? null,
        experienceHint: lo != null && lo >= 0 ? { min: lo, max: hi != null && hi >= lo ? hi : null } : undefined,
        fetchedAt: new Date(),
        raw: { jobId: j.jobId } as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
