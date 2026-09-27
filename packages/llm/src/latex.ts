import { splitLatexDocument, texEscape, type Evidence, type Posting, type Profile } from "@jobflow/core";
import { candidateName } from "./prompts.js";

/**
 * Deterministic LaTeX résumé builders (§ Customize). The built-in preamble is what a
 * model writes a body for when there's no imported .tex, and what Markdown converts
 * into. Only geometry, enumitem and hyperref — all in a stock MiKTeX / TeX Live / tectonic
 * install — so it compiles without fetching extra packages.
 */

export const BUILTIN_PREAMBLE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=0.7in]{geometry}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}
\setlength{\parindent}{0pt}
\setlength{\parskip}{2pt}
\pagenumbering{gobble}
\makeatletter
\renewcommand\section{\@startsection{section}{1}{\z@}{-10pt plus -2pt}{4pt}{\normalfont\large\bfseries}}
\renewcommand\subsection{\@startsection{subsection}{2}{\z@}{-6pt plus -1pt}{2pt}{\normalfont\normalsize\bfseries}}
\makeatother
\begin{document}`;

export const BUILTIN_RESUME_TEMPLATE = `${BUILTIN_PREAMBLE}\n% body\n\\end{document}\n`;

/** Wrap a body in the built-in preamble. */
export function withBuiltinPreamble(body: string): string {
  return `${BUILTIN_PREAMBLE}\n${body.trim()}\n\\end{document}\n`;
}

/** Build a clean, compilable .tex from structured profile + evidence (no LLM). */
export function renderBuiltinResume(profile: Profile, evidence: Evidence[], posting?: Posting | null): string {
  const c = profile.prefs.contact;
  const name = candidateName(profile) || "Your Name";
  const contactBits = [c.email, c.phone, c.linkedin, c.github, c.portfolio].filter(Boolean).map(texEscape);
  // the About narrative only — never raw résumé text, which starts with the header block
  const summarySrc = (profile.aboutText || "").replace(/\s+/g, " ").trim().slice(0, 400);
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

  const targeted = posting ? `% Built for ${texEscape(posting.title)} @ ${texEscape(posting.companyName)} (not tailored)\n` : "";

  const body = [
    `\\begin{center}`,
    `  {\\LARGE \\textbf{${texEscape(name)}}}${contactBits.length ? "\\\\[2pt]" : ""}`,
    contactBits.length ? `  ${contactBits.join(" \\quad ")}` : "",
    `\\end{center}`,
    "",
    summarySrc ? `\\section*{Summary}\n${texEscape(summarySrc)}\n` : "",
    skills.length ? `\\section*{Skills}\n${skills.join(", ")}\n` : "",
    `\\section*{Selected Projects \\& Experience}`,
    `\\begin{itemize}`,
    bullets || "  \\item Add your résumé or evidence entries in Settings to populate this section.",
    `\\end{itemize}`,
  ]
    .filter(Boolean)
    .join("\n");

  return withBuiltinPreamble(targeted + body);
}

// **bold** | __bold__ | [text](url) | `code` | *italic* | _italic_ (not inside snake_case words)
const INLINE_RE =
  /\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g;

function texUrl(u: string): string {
  return u.replace(/\\/g, "").replace(/([%#&])/g, "\\$1");
}

/** Markdown inline markup → LaTeX, escaping everything else. */
export function markdownInlineToTex(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    out += texEscape(s.slice(last, m.index));
    const bold = m[1] ?? m[2];
    if (bold !== undefined) out += `\\textbf{${markdownInlineToTex(bold)}}`;
    else if (m[3] !== undefined) out += `\\href{${texUrl(m[4] ?? "")}}{${markdownInlineToTex(m[3])}}`;
    else if (m[5] !== undefined) out += `\\texttt{${texEscape(m[5])}}`;
    else out += `\\textit{${markdownInlineToTex(m[6] ?? m[7] ?? "")}}`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + texEscape(s.slice(last));
}

/**
 * A Markdown résumé → a full .tex on the built-in preamble, so the common format can be
 * compiled to a real PDF (and attached by the autofill agent) like the LaTeX one.
 * Covers what résumés use: `#` name + the contact lines under it (centered), `##`/`###`
 * headings, `-` bullets, paragraphs, `---` rules, and inline bold/italic/code/links.
 */
export function markdownToLatex(md: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  let header: string[] | null = null; // the name + contact lines, until the first section
  const closeList = () => {
    if (inList) out.push("\\end{itemize}");
    inList = false;
  };
  const flushHeader = () => {
    if (header) out.push("\\begin{center}", header.join(" \\\\\n"), "\\end{center}");
    header = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#\s+(.*)$/))) {
      closeList();
      flushHeader();
      header = [`{\\LARGE \\textbf{${markdownInlineToTex(m[1]!.trim())}}}`];
    } else if ((m = line.match(/^##\s+(.*)$/))) {
      closeList();
      flushHeader();
      out.push(`\\section*{${markdownInlineToTex(m[1]!.trim())}}`);
    } else if ((m = line.match(/^#{3,6}\s+(.*)$/))) {
      closeList();
      flushHeader();
      out.push(`\\subsection*{${markdownInlineToTex(m[1]!.trim())}}`);
    } else if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList();
      flushHeader();
      out.push("\\medskip\\hrule\\medskip");
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushHeader();
      if (!inList) out.push("\\begin{itemize}");
      inList = true;
      out.push(`  \\item ${markdownInlineToTex(m[1]!.trim())}`);
    } else if (header) {
      header.push(markdownInlineToTex(line.trim()));
    } else {
      closeList();
      out.push(`${markdownInlineToTex(line.trim())}\\par`);
    }
  }
  closeList();
  flushHeader();
  return withBuiltinPreamble(out.join("\n") || "\\mbox{}");
}

/** Strip ```latex … ``` fences an LLM may wrap the document in. */
export function stripLatexFences(s: string): string {
  return s
    .replace(/^\s*```(?:la)?tex\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * The document body from a model reply that was asked for only the body: strips fences,
 * and if the model returned a whole document anyway, keeps just its body. A trailing
 * `\end{document}` is dropped (we splice our own).
 */
export function extractLatexBody(raw: string): string {
  const s = stripLatexFences(raw);
  const split = splitLatexDocument(s);
  if (split) return split.body.trim();
  return s.replace(/\\end\{document\}\s*$/, "").replace(/^[\s\S]*?\\begin\{document\}/, "").trim();
}
