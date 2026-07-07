import type { Evidence, Posting, Profile } from "@jobflow/core";

/**
 * Deterministic Markdown résumé builder (§ Customize — common/plain-text output).
 * The zero-dependency, no-TeX default: works for everyone, is the fallback whenever an
 * LLM returns non-résumé text (e.g. the offline echo provider). Mirrors latex.ts.
 */

/** Build a clean GitHub-flavored-Markdown résumé from structured profile + evidence. */
export function renderBuiltinResumeMarkdown(profile: Profile, evidence: Evidence[], posting?: Posting | null): string {
  const c = profile.prefs.contact;
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Your Name";
  const contact = [c.email, c.phone, c.linkedin, c.github, c.portfolio].filter(Boolean).join(" · ");
  const summary = (profile.aboutText || profile.masterResume || "").replace(/\s+/g, " ").trim().slice(0, 320);
  const skills = profile.prefs.stackProfile.map((s) => s.replace(/_/g, " "));
  const bullets = evidence
    .slice(0, 8)
    .map((e) => {
      const metric = e.metric ? ` _(${e.metric})_` : "";
      return `- **${e.project}:** ${e.headline || e.project}. ${(e.detail || "").trim()}${metric}`.trimEnd();
    })
    .join("\n");

  const out: string[] = [];
  if (posting) out.push(`<!-- Tailored for ${posting.title} @ ${posting.companyName} -->`);
  out.push(`# ${name}`);
  if (contact) out.push(contact);
  if (summary) out.push(`\n## Summary\n\n${summary}`);
  if (skills.length) out.push(`\n## Skills\n\n${skills.join(", ")}`);
  out.push(`\n## Experience & Projects\n`);
  out.push(bullets || "- Add evidence entries in Settings to populate this section.");
  return out.join("\n");
}

/** Strip ```markdown / ``` fences an LLM may wrap the document in. */
export function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/** Heuristic: is this a résumé-shaped Markdown doc (not echo junk / prose)? */
export function looksLikeMarkdownResume(s: string): boolean {
  const t = s.trim();
  if (t.length < 20) return false;
  const firstLine = t.split("\n", 1)[0] ?? "";
  return /^#\s/.test(firstLine) || /\n##\s/.test(t);
}
