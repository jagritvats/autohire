/**
 * LaTeX helpers (§ Customize — LaTeX résumé import + tailoring). Pure + dependency-free.
 * `latexToText` reduces a .tex to readable text for evidence-grounded generation;
 * `texEscape` makes arbitrary strings safe to drop into a LaTeX document.
 */

/** Escape the LaTeX special characters so a plain string renders literally. */
export function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/**
 * Strip a LaTeX document to plain text — enough for grounding/preview, not a full
 * renderer. Drops the preamble, comments, and commands while keeping their text
 * arguments (so `\textbf{Kafka}` → `Kafka`, `\section{Experience}` → `Experience`).
 */
export function latexToText(tex: string): string {
  let s = tex;
  // drop everything before \begin{document} if present (the preamble)
  const begin = s.indexOf("\\begin{document}");
  if (begin >= 0) s = s.slice(begin + "\\begin{document}".length);
  const end = s.indexOf("\\end{document}");
  if (end >= 0) s = s.slice(0, end);

  s = s
    .replace(/(^|[^\\])%.*$/gm, "$1") // line comments (not escaped \%)
    .replace(/\\(begin|end)\{[^}]*\}/g, "\n") // environment delimiters → breaks
    .replace(/\\item\b/g, "\n• ") // list items → bullets
    .replace(/\\\\/g, "\n") // line breaks
    .replace(/\\(section|subsection|subsubsection|textbf|textit|emph|underline|href|texttt|large|Large|huge|Huge)\*?\s*(\[[^\]]*\])?/g, "")
    // keep the {…} argument text of remaining commands, drop the command name
    .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\([&%$#_{}~^])/g, "$1") // unescape literals
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

/** True when a string looks like a full LaTeX document (used for generation fallback). */
export function isLatexDocument(s: string): boolean {
  return /\\documentclass/.test(s) && /\\begin\{document\}/.test(s);
}
