import { texEscape, type Evidence, type Posting, type Profile } from "@jobflow/core";

/**
 * Deterministic LaTeX résumé builder (§ Customize). Used as the fallback when no base
 * .tex is imported, and whenever an LLM returns non-LaTeX (e.g. the offline echo
 * provider) — so a tailored résumé is ALWAYS compilable. Only `geometry` + `enumitem`
 * so it builds on a stock pdflatex/MiKTeX without fetching extra packages.
 */

export const BUILTIN_RESUME_TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=0.9in]{geometry}
\usepackage{enumitem}
\setlist[itemize]{leftmargin=1.2em,itemsep=2pt,topsep=2pt}
\pagenumbering{gobble}
\begin{document}
% body
\end{document}`;

/** Build a clean, compilable .tex from structured profile + evidence (no LLM). */
export function renderBuiltinResume(profile: Profile, evidence: Evidence[], posting?: Posting | null): string {
  const c = profile.prefs.contact;
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Your Name";
  const contactBits = [c.email, c.phone, c.linkedin, c.github, c.portfolio].filter(Boolean).map(texEscape);
  const summarySrc = (profile.aboutText || profile.masterResume || "").replace(/\s+/g, " ").trim().slice(0, 320);
  const skills = profile.prefs.stackProfile.map((s) => texEscape(s.replace(/_/g, " ")));

  const bullets = evidence
    .slice(0, 8)
    .map((e) => {
      const head = texEscape(e.headline || e.project);
      const detail = texEscape(e.detail || "");
      const metric = e.metric ? ` \\textit{(${texEscape(e.metric)})}` : "";
      return `  \\item \\textbf{${texEscape(e.project)}:} ${head}. ${detail}${metric}`;
    })
    .join("\n");

  const targeted = posting ? `% Tailored for ${texEscape(posting.title)} @ ${texEscape(posting.companyName)}\n` : "";

  const body = [
    `\\begin{center}`,
    `  {\\Large \\textbf{${texEscape(name)}}}\\\\[2pt]`,
    contactBits.length ? `  ${contactBits.join(" \\quad ")}` : "",
    `\\end{center}`,
    "",
    summarySrc ? `\\section*{Summary}\n${texEscape(summarySrc)}\n` : "",
    skills.length ? `\\section*{Skills}\n${skills.join(", ")}\n` : "",
    `\\section*{Selected Projects \\& Experience}`,
    `\\begin{itemize}`,
    bullets || "  \\item Add evidence entries in Settings to populate this section.",
    `\\end{itemize}`,
  ]
    .filter(Boolean)
    .join("\n");

  return BUILTIN_RESUME_TEMPLATE.replace("% body", targeted + body);
}

/** Strip ```latex … ``` fences an LLM may wrap the document in. */
export function stripLatexFences(s: string): string {
  return s
    .replace(/^\s*```(?:la)?tex\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}
