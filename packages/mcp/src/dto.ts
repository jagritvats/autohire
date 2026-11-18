import { z } from "zod";
import type { FeedCard } from "@jobflow/service";

/**
 * The shapes agents get back (MCP `outputSchema` + `structuredContent`), built from the
 * same FeedCard DTO the web app and the CLI render — so an agent, the terminal and the UI
 * never disagree about a role. Honesty rules carry over: a score is null when nothing was
 * scored (no profile yet), and modelled pay is always labelled an estimate.
 */

export const PayOut = z
  .object({
    label: z.string().describe('e.g. "₹30L–₹45L" or "$170k–$210k"'),
    kind: z.enum(["stated", "estimate"]).describe("stated = written in the posting; estimate = JobFlow's model, NOT stated by the employer"),
    confidence: z.string().describe("stated: parse confidence (low/medium/high); estimate: low/medium/high"),
    confidenceScore: z.number().nullable().describe("estimates only, 0..1"),
    basis: z.string().nullable().describe("estimates only: what the estimate rests on"),
  })
  .describe("Pay. Never present an estimate as what the employer offers.");

export const JobSummaryOut = z.object({
  id: z.string().describe("posting id — pass it (or a unique prefix of ≥ 4 characters) to get_job, track_application, prepare_application, draft_document"),
  title: z.string(),
  company: z.string(),
  location: z.string().describe('the card\'s plain-language location, e.g. "Remote · worldwide", "Remote · Canada only", "Hybrid · München, Germany", "Onsite · Bengaluru, India + Singapore"'),
  places: z.array(z.string()).describe("every place the posting names, primary first"),
  workMode: z.string().describe("remote | hybrid | onsite | unknown"),
  remoteGeo: z.string().describe("where a remote role may be done from (worldwide, us_only, eu_only, india_ok, country_only = residents of `country` only, …)"),
  score: z.number().nullable().describe("0–100 fit against the user's profile; null when unscored (no profile yet)"),
  fitNote: z.string().nullable().describe("the stack-fit note (what overlaps / what's missing)"),
  levelNote: z.string().nullable().describe("seniority / experience note"),
  redFlags: z.array(z.string()).describe("honest caveats from the scorer — cite these, don't hide them"),
  experience: z.object({ min: z.number().nullable(), max: z.number().nullable(), fit: z.enum(["ok", "stretch", "far"]).nullable() }),
  pay: PayOut.nullable(),
  ageDays: z.number().describe("days since the source posted it (else since JobFlow first saw it)"),
  source: z.string(),
  atsDirect: z.boolean().describe("true = straight from the employer's ATS board; false = an aggregator"),
  skills: z.array(z.string()),
  presets: z.array(z.string()).describe("discovery-preset tags: india, us, eu-uk, global-remote"),
  applyUrl: z.string().nullable(),
  applied: z.boolean().describe("the user already applied to this company+role"),
  agency: z.boolean().describe("posted by a staffing agency / third-party recruiter, not the employer — tell the user"),
  workable: z.boolean().nullable().describe("workable for the user (an office in their home country or a market, or remote open to where they live); null = can't tell"),
  alsoPostedFor: z
    .array(z.object({ id: z.string(), place: z.string() }))
    .describe("the same role posted by the same company for other countries (separate reqs, folded under this one); get_job reads each"),
});
export type JobSummary = z.infer<typeof JobSummaryOut>;

/** the card's own plain-language location line — the same words the web and the CLI show */
export function locationLabel(c: Pick<FeedCard, "location">): string {
  return c.location.label || "Location not stated";
}

export function payOf(c: FeedCard): JobSummary["pay"] {
  if (!c.comp) return null;
  return {
    label: c.comp.label,
    kind: c.comp.estimate ? "estimate" : "stated",
    confidence: c.comp.confidence,
    confidenceScore: c.comp.confidenceScore,
    basis: c.comp.basis,
  };
}

export function payText(p: JobSummary["pay"]): string | null {
  if (!p) return null;
  if (p.kind === "estimate") return `~${p.label} (JobFlow estimate${p.confidenceScore != null ? `, ${Math.round(p.confidenceScore * 100)}% confidence` : ""} — not stated)`;
  return `${p.label} (stated)`;
}

export function summarize(c: FeedCard, scored: boolean): JobSummary {
  return {
    id: c.id,
    title: c.title,
    company: c.company,
    location: locationLabel(c),
    places: c.location.places,
    workMode: c.location.mode,
    remoteGeo: c.location.remoteGeo,
    score: scored ? c.score : null,
    fitNote: c.stackNote,
    levelNote: c.levelNote,
    redFlags: c.redFlags,
    experience: c.experience,
    pay: payOf(c),
    ageDays: c.ageDays,
    source: c.source,
    atsDirect: c.atsDirect,
    skills: c.skills,
    presets: c.presets ?? [],
    applyUrl: c.applyUrl,
    applied: c.applied,
    agency: c.agency,
    workable: c.workable,
    alsoPostedFor: (c.siblings ?? []).map((x) => ({ id: x.id, place: x.place })),
  };
}

/** One job as a few lines of text (the human-readable half of a tool result). */
export function jobLines(j: JobSummary, i?: number): string {
  const head = `${i != null ? `${i}. ` : ""}${j.score != null ? `[${j.score}] ` : ""}${j.title} · ${j.company} · ${j.location}`;
  const meta = [
    payText(j.pay),
    j.ageDays <= 0 ? "today" : `${j.ageDays}d old`,
    j.source + (j.atsDirect ? "" : " (aggregator)"),
    j.agency ? "staffing agency, not the employer" : null,
    experienceText(j.experience),
    j.presets.length ? j.presets.map((p) => `#${p}`).join(" ") : null,
    j.applied ? "already applied" : null,
  ].filter(Boolean);
  const lines = [head, `   ${meta.join(" · ")}`];
  if (j.fitNote) lines.push(`   fit: ${j.fitNote}`);
  if (j.alsoPostedFor.length) lines.push(`   also posted for: ${j.alsoPostedFor.map((x) => `${x.place} (${x.id})`).join(", ")}`);
  if (j.levelNote) lines.push(`   level: ${j.levelNote}`);
  if (j.redFlags.length) lines.push(`   watch: ${j.redFlags.join(" · ")}`);
  lines.push(`   id: ${j.id}`);
  return lines.join("\n");
}

/** "asks 3–5 yrs", "asks 4 yrs (stretch)" — null when the posting states none */
export function experienceText(e: JobSummary["experience"]): string | null {
  if (e.min == null && e.max == null) return null;
  const range = e.min != null && e.max != null ? (e.min === e.max ? `${e.min}` : `${e.min}–${e.max}`) : e.min != null ? `${e.min}+` : `up to ${e.max}`;
  return `asks ${range} yrs${e.fit && e.fit !== "ok" ? ` (${e.fit})` : ""}`;
}

export function hiddenText(hidden: Record<string, number> | undefined, total: number | undefined, what: string): string | null {
  if (!total) return null;
  const parts = Object.entries(hidden ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return `${what} hid ${total} (${parts.join(", ")}) — a view only hides, it never changes a score.`;
}

/** Dates → ISO strings, undefined dropped: structuredContent must be plain JSON. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const HiddenOut = z.record(z.number()).describe("per reason: how many results the query/view hid (never silent)");
