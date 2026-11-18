import type { ExperienceRange, LevelBand, RawPosting } from "@jobflow/core";
import { decodeEntities, htmlToText, httpStatus, httpText, liveFromStatus, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";

/**
 * Personio recruiting XML feed (Tier 1: the public, documented job feed every Personio
 * career page exposes, no auth) — DACH/EU SMBs and scale-ups (1KOMMA5°, tado…).
 * slug = the {slug}.jobs.personio.de (or .com) subdomain. Verified live 2026-11:
 *   GET https://{slug}.jobs.personio.de/xml   → <workzag-jobs><position>… every open job, JD inline
 *       (NOT ?language=en: it blanks the JD of every job without an English version —
 *       288 of 325 at one tenant — so the feed is read in the employer's own language)
 *   GET https://{slug}.jobs.personio.de/job/{id}          → 404 once the job is unpublished
 * `createdAt` is the position's creation date (used as the publish date). An unknown slug
 * answers 404. Offices are often a bare city ("München") — no country is invented.
 */

export interface PersonioPosition {
  id: string;
  name: string;
  subcompany: string;
  office: string;
  additionalOffices: string[];
  department: string;
  seniority: string;
  yearsOfExperience: string;
  employmentType: string;
  schedule: string;
  keywords: string;
  createdAt: string;
  sections: Array<{ name: string; html: string }>;
  salary: { min: string; max: string; currency: string; type: string } | null;
}

export class PersonioAdapter implements SourceAdapter {
  readonly source = "personio" as const;
  readonly tier = "tier1" as const;

  /** the public job page: 404 once unpublished (verified 2026-11) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const host = personioHost(job.slug);
    if (!host || !/^\d+$/.test(job.jobId)) return null;
    return liveFromStatus(await httpStatus(`https://${host}/job/${job.jobId}`, { headers: { Accept: "text/html" } }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const host = personioHost(target.slug);
    if (!host) return [];
    const xml = await httpText(`https://${host}/xml`, { timeoutMs: 45_000, headers: { Accept: "application/xml" } });
    if (!xml || !/<workzag-jobs\b/.test(xml)) return [];
    return toRawPostings(parsePersonioXml(xml), host);
  }
}

/** "{slug}" | "{slug}.jobs.personio.de|com" | a URL on either → the feed host. */
export function personioHost(s: string | null | undefined): string | null {
  const raw = (s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  const m = raw.match(/^([a-z0-9-]+)(?:\.jobs\.personio\.(de|com))?$/);
  return m ? `${m[1]}.jobs.personio.${m[2] ?? "de"}` : null;
}

/** Minimal parse of Personio's flat <position> feed (CDATA sections, entity-escaped text). */
export function parsePersonioXml(xml: string): PersonioPosition[] {
  const text = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m?.[1]) return "";
    const cdata = m[1].trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return cdata ? cdata[1]!.trim() : decodeEntities(m[1]).trim();
  };
  const out: PersonioPosition[] = [];
  for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const full = m[1]!;
    // the JD sections carry their own <name>s — read the position's fields without them
    const descBlock = full.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/)?.[1] ?? "";
    const officesBlock = full.match(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/)?.[1] ?? "";
    const salaryBlock = full.match(/<salaryInformation>([\s\S]*?)<\/salaryInformation>/)?.[1] ?? "";
    const b = full
      .replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, "")
      .replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/, "")
      .replace(/<salaryInformation>[\s\S]*?<\/salaryInformation>/, "");
    const id = text(b, "id");
    const name = text(b, "name");
    if (!id || !name) continue;
    out.push({
      id,
      name,
      subcompany: text(b, "subcompany"),
      office: text(b, "office"),
      additionalOffices: [...officesBlock.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((o) => decodeEntities(o[1]!).trim()).filter(Boolean),
      department: text(b, "department"),
      seniority: text(b, "seniority"),
      yearsOfExperience: text(b, "yearsOfExperience"),
      employmentType: text(b, "employmentType"),
      schedule: text(b, "schedule"),
      keywords: text(b, "keywords"),
      createdAt: text(b, "createdAt"),
      sections: [...descBlock.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map((d) => ({ name: text(d[1]!, "name"), html: text(d[1]!, "value") })),
      salary: salaryBlock
        ? { min: text(salaryBlock, "min"), max: text(salaryBlock, "max"), currency: text(salaryBlock, "currencyCode"), type: text(salaryBlock, "type") }
        : null,
    });
  }
  return out;
}

function toRawPostings(positions: PersonioPosition[], host: string): RawPosting[] {
  const slug = host.split(".")[0]!;
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const p of positions) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const offices = [...new Set([p.office, ...p.additionalOffices].filter(Boolean))];
    const remote = offices.some((o) => /^remote\b|\bremote$/i.test(o));
    const places = offices.filter((o) => !/^remote$/i.test(o));
    const jd = p.sections.map((s) => [s.name, htmlToText(s.html)].filter(Boolean).join("\n")).join("\n\n");
    const t = Date.parse(p.createdAt);
    out.push({
      source: "personio",
      tier: "tier1",
      atsType: "personio",
      atsJobId: p.id,
      companyName: p.subcompany || slug,
      companySlug: slug,
      title: p.name,
      jdText: [jd, p.keywords ? `Keywords: ${p.keywords}` : ""].filter(Boolean).join("\n\n"),
      jdHtml: p.sections.map((s) => s.html).join("\n") || null,
      locationRaw: places.length ? `${remote ? "Remote - " : ""}${places.join("; ")}` : remote ? "Remote" : null,
      applyUrl: `https://${host}/job/${p.id}`,
      salaryRaw: p.salary?.currency && (Number(p.salary.min) > 0 || Number(p.salary.max) > 0)
        ? `${p.salary.currency} ${[p.salary.min, p.salary.max].filter((x) => Number(x) > 0).map((x) => String(Math.round(Number(x)))).join(" - ")}${p.salary.type ? ` ${p.salary.type}` : ""}`
        : null,
      postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      levelHint: PERSONIO_LEVELS[p.seniority] ?? (p.employmentType === "intern" || p.employmentType === "working_student" ? "intern" : null),
      experienceHint: personioYears(p.yearsOfExperience),
      fetchedAt: new Date(),
      raw: { id: p.id, department: p.department, employmentType: p.employmentType, schedule: p.schedule } as Record<string, unknown>,
    });
  }
  return out;
}

/** Personio seniority; "experienced" spans mid→senior, so no hint. */
const PERSONIO_LEVELS: Record<string, LevelBand> = { student: "intern", "entry-level": "junior", executive: "director" };

/** "lt-1" | "1-2" | "2-5" | "5-7" | "7-10" | "gt-10" → years. */
export function personioYears(s: string): ExperienceRange | undefined {
  if (s === "lt-1") return { min: 0, max: 1 };
  const gt = s.match(/^gt-(\d+)$/);
  if (gt) return { min: Number(gt[1]), max: null };
  const r = s.match(/^(\d+)-(\d+)$/);
  return r ? { min: Number(r[1]), max: Number(r[2]) } : undefined;
}
