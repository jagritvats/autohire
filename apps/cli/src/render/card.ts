import type { FeedCard } from "@jobflow/service";
import { ago, type Out } from "../output.js";

/**
 * The match card in the terminal (§11.6) — the same FeedCard DTO the web renders, so the
 * CLI and the UI never disagree about a role. Scores are shown only when they're real
 * (scored against an onboarded profile); estimates are always labelled as estimates.
 */

export type CardLike = FeedCard & { relevance?: number; inFeed?: boolean };

/** the card's own plain-language location line — one wording on every surface */
export function locationLabel(c: Pick<FeedCard, "location">): string {
  return c.location.label || "Location not stated";
}

export function compLabel(c: FeedCard): string | null {
  if (!c.comp) return null;
  if (c.comp.estimate) {
    const pct = c.comp.confidenceScore != null ? ` ${Math.round(c.comp.confidenceScore * 100)}%` : "";
    return `~${c.comp.label} (estimate${pct})`;
  }
  return `${c.comp.label} (stated)`;
}

/** "3–5 yrs", "4 yrs", "5+ yrs", "up to 2 yrs" */
export function experienceLabel(e: FeedCard["experience"]): string | null {
  if (e.min == null && e.max == null) return null;
  const range = e.min != null && e.max != null ? (e.min === e.max ? `${e.min}` : `${e.min}–${e.max}`) : e.min != null ? `${e.min}+` : `up to ${e.max}`;
  return `${range} yrs`;
}

export function scoreBadge(out: Out, score: number, scored: boolean): string {
  if (!scored) return out.dim(" -- ");
  const s = String(score).padStart(3, " ");
  return score >= 80 ? out.green(out.bold(s)) : score >= 60 ? out.yellow(s) : out.dim(s);
}

export function renderCard(out: Out, c: CardLike, idx: number, opts: { scored: boolean; jdNote?: boolean; moreAtCompany?: number } = { scored: true }): string {
  const lines: string[] = [];
  const num = out.dim(`${String(idx).padStart(2, " ")}.`);
  lines.push(`${num} ${scoreBadge(out, c.score, opts.scored)}  ${out.bold(c.title)} ${out.dim("·")} ${c.company} ${out.dim("·")} ${locationLabel(c)}`);
  const indent = "        ";
  const meta = [
    compLabel(c),
    ago(c.ageDays),
    c.source + (c.atsDirect ? "" : " (aggregator)"),
    c.agency ? out.yellow("staffing agency") : null,
    c.level ? c.level : null,
    experienceLabel(c.experience) ? `asks ${experienceLabel(c.experience)}${c.experience.fit && c.experience.fit !== "ok" ? ` (${c.experience.fit})` : ""}` : null,
  ].filter(Boolean);
  lines.push(indent + out.dim(meta.join(" · ")));
  if (c.stackNote) lines.push(`${indent}${out.cyan("fit")}   ${c.stackNote}`);
  else if (c.skills.length) lines.push(`${indent}${out.cyan("stack")} ${c.skills.slice(0, 8).join(", ")}`);
  if (c.levelNote) lines.push(`${indent}${out.cyan("level")} ${c.levelNote}`);
  if (c.redFlags.length) lines.push(`${indent}${out.yellow("watch")} ${c.redFlags.join(" · ")}`);
  // the same role posted for other countries, folded under this card: each is `jobflow show <id>`
  if (c.alsoPosted) lines.push(indent + out.dim(`${c.alsoPosted} — ${(c.siblings ?? []).slice(0, 4).map((s) => `${s.place} ${s.id.slice(0, 8)}`).join(", ")}`));
  const tags = [(c.presets ?? []).length ? out.cyan((c.presets ?? []).map((p) => `#${p}`).join(" ")) : null, c.applied ? out.green("applied") : null, c.bookmarked ? "bookmarked" : null, c.inFeed === false ? out.dim("not in your feed yet") : null].filter(Boolean);
  if (tags.length) lines.push(indent + tags.join(" · "));
  if (c.applyUrl) lines.push(indent + out.dim(c.applyUrl));
  if (opts.moreAtCompany) lines.push(indent + out.dim(`+${opts.moreAtCompany} more at ${c.company} further down`));
  return lines.join("\n");
}

export function cardRows(out: Out, cards: CardLike[], scored: boolean): string[][] {
  return cards.map((c, i) => [
    String(i + 1),
    scored ? String(c.score) : "--",
    c.title,
    c.company,
    locationLabel(c),
    compLabel(c) ?? "",
    ago(c.ageDays),
    [c.agency ? "agency" : null, ...(c.presets ?? []).map((p) => `#${p}`)].filter(Boolean).join(" "),
  ]);
}

export const CARD_HEADERS = ["#", "score", "title", "company", "location", "comp", "posted", "tags"];
export const CARD_WIDTHS = [3, 5, 42, 22, 24, 30, 9, 24];

/** cards or a table, numbered so `jobflow show 3` / `apply 3` can refer to a row */
export function printCards(out: Out, cards: CardLike[], opts: { scored: boolean; format?: string; moreBelow?: Map<number, number> }): void {
  if (opts.format === "table") {
    out.table(CARD_HEADERS, cardRows(out, cards, opts.scored), { maxWidth: CARD_WIDTHS });
    return;
  }
  cards.forEach((c, i) => {
    out.line(renderCard(out, c, i + 1, { scored: opts.scored, moreAtCompany: opts.moreBelow?.get(i) }));
    out.line();
  });
}
