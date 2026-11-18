import type { FeedCard } from "@jobflow/service";

/**
 * Plain-language labels for a job card, shared by the feed, search results and the Job page
 * so every surface says the same thing the same way. No internals ("ATS-direct", "CRM",
 * "archetype") in user-facing copy.
 */

/**
 * The card's own location line ("Remote · worldwide", "Remote · Canada only", "Hybrid ·
 * München, Germany", "Onsite · Bengaluru, India + Singapore") — built once in the service
 * (`describeLocation`) so the web, the CLI and the MCP tools say exactly the same thing.
 */
export function locationText(c: Pick<FeedCard, "location">): string {
  return c.location.label || "Location not stated";
}

export function ageText(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** "~2–3 yrs" style label for the YoE the JD asks; null when unstated. */
export function experienceText(e: FeedCard["experience"]): string | null {
  const { min, max } = e;
  if (min == null && max == null) return null;
  if (min != null && max != null) return min === max ? `${min} yr${min === 1 ? "" : "s"}` : `${min}–${max} yrs`;
  if (min != null) return `${min}+ yrs`;
  return `up to ${max} yrs`;
}

export function payText(c: Pick<FeedCard, "comp">): { text: string; title: string; estimate: boolean } | null {
  if (!c.comp) return null;
  if (c.comp.estimate) {
    const pct = c.comp.confidenceScore != null ? ` · ${Math.round(c.comp.confidenceScore * 100)}% confident` : "";
    return { text: `~${c.comp.label} (estimate${pct})`, title: `The posting states no pay — this is an estimate. ${c.comp.basis ?? ""}`, estimate: true };
  }
  return { text: c.comp.label, title: `Stated in the posting (parse confidence: ${c.comp.confidence})`, estimate: false };
}

export function sourceText(c: Pick<FeedCard, "atsDirect" | "ats" | "source">): string {
  return c.atsDirect ? `from the employer's ${c.ats} board` : `via ${c.source.replace(/_/g, " ")}`;
}

export function roleText(archetype: string): string {
  return archetype.replace(/_/g, " / ").replace("infra / devops", "infra / DevOps").replace("data / ml", "data / ML");
}

export const STATUS_LABEL: Record<string, string> = {
  saved: "Saved",
  drafting: "Preparing",
  ready: "Ready to apply",
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  ghosted: "No response",
};
