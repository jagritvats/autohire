/**
 * LaTeX helpers (§ Customize — LaTeX résumé import + tailoring). Pure + dependency-free.
 * `latexToText` reduces a .tex to readable text for evidence-grounded generation;
 * `texEscape` makes arbitrary strings safe to drop into a LaTeX document.
 */

/**
 * Symbols résumé text carries (often from a PDF extraction) that pdflatex can't typeset
 * from raw UTF-8 ("Unicode character → not set up for use with LaTeX").
 */
const UNICODE_TEX: Record<string, string> = {
  "→": "$\\rightarrow$", "←": "$\\leftarrow$", "↔": "$\\leftrightarrow$", "⇒": "$\\Rightarrow$",
  "×": "$\\times$", "≈": "$\\approx$", "≥": "$\\geq$", "≤": "$\\leq$", "±": "$\\pm$", "•": "\\textbullet{}",
  "·": "\\textperiodcentered{}", "₹": "Rs.~", "€": "EUR~", "✓": "", "✔": "", "★": "", "​": "", "﻿": "",
};

/** Escape the LaTeX special characters so a plain string renders literally. */
export function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/[→←↔⇒×≈≥≤±•·₹€✓✔★​﻿]/g, (c) => UNICODE_TEX[c] ?? c)
    // emoji / pictographs have no glyph in the stock fonts
    .replace(/\p{Extended_Pictographic}/gu, "");
}

const BEGIN_DOC = "\\begin{document}";
const END_DOC = "\\end{document}";

/** True when `idx` sits after an unescaped % on its line (i.e. inside a comment). */
function inComment(tex: string, idx: number): boolean {
  const lineStart = tex.lastIndexOf("\n", idx - 1) + 1;
  return /(^|[^\\])%/.test(tex.slice(lineStart, idx));
}

/**
 * Split a full .tex into its fixed preamble (through `\begin{document}`) and the body.
 * Tailoring rewrites only the body and splices it back, so the candidate's styling,
 * packages and macros survive byte-for-byte. Null when it isn't a full document.
 */
export function splitLatexDocument(tex: string): { preamble: string; body: string } | null {
  let begin = tex.indexOf(BEGIN_DOC);
  while (begin >= 0 && inComment(tex, begin)) begin = tex.indexOf(BEGIN_DOC, begin + 1);
  if (begin < 0) return null;
  const bodyStart = begin + BEGIN_DOC.length;
  let end = tex.lastIndexOf(END_DOC);
  while (end >= bodyStart && inComment(tex, end)) end = tex.lastIndexOf(END_DOC, end - 1);
  if (end < bodyStart) return null;
  return { preamble: tex.slice(0, bodyStart), body: tex.slice(bodyStart, end) };
}

/** Drop comments (unescaped % to end of line) so they don't skew structural checks. */
function stripTexComments(tex: string): string {
  return tex.replace(/(^|[^\\])%.*$/gm, "$1");
}

/**
 * Structural problems that mean a document body won't compile — almost always a model
 * that stopped mid-document. Checks brace balance, \begin/\end pairing, and the
 * `\fooStart`/`\fooEnd` macro pairs popular templates (Jake's résumé) use for lists.
 * Empty array = structurally sound (not a guarantee it compiles).
 */
export function latexBodyIssues(body: string): string[] {
  const src = stripTexComments(body);
  const issues: string[] = [];
  if (!src.trim()) return ["the body is empty"];
  if (/\\documentclass|\\usepackage\b|\\begin\{document\}/.test(src)) issues.push("the body contains preamble commands");

  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++; // skip the escaped char (\{, \}, \\)
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) {
      issues.push("a closing brace } has no matching {");
      depth = 0;
      break;
    }
  }
  if (depth > 0) issues.push(`${depth} unclosed brace${depth > 1 ? "s" : ""} {`);

  const stack: string[] = [];
  for (const m of src.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    const [, kind, env] = m as unknown as [string, string, string];
    if (kind === "begin") stack.push(env);
    else if (stack[stack.length - 1] === env) stack.pop();
    else {
      issues.push(`\\end{${env}} does not match ${stack.length ? `\\begin{${stack[stack.length - 1]}}` : "any \\begin"}`);
      break;
    }
  }
  for (const env of stack) issues.push(`\\begin{${env}} is never closed`);

  const starts = new Map<string, number>();
  for (const m of src.matchAll(/\\([A-Za-z]+)(Start|End)\b/g)) {
    const name = m[1]!;
    starts.set(name, (starts.get(name) ?? 0) + (m[2] === "Start" ? 1 : -1));
  }
  for (const [name, n] of starts) if (n !== 0) issues.push(`\\${name}Start/\\${name}End are unbalanced`);
  return issues;
}

/** `\section{…}` titles in order — used to check a rewrite kept every section. */
export function latexSectionTitles(body: string): string[] {
  return [...stripTexComments(body).matchAll(/\\section\*?\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
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
