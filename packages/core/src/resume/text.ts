import { latexToText } from "../util/latex.js";

/**
 * Text clean-up for résumé imports. Everything here is LOSSLESS in content — it fixes
 * layout artefacts (PDF hyphenation, bullet glyphs, glued dates, markup) so the parser
 * sees one claim per line, but never adds, drops or rewords a claim (invariant #3).
 */

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

/** Bullet glyphs PDFs/DOCX/markdown use at line start → a uniform "- ". */
// glyphs that are only ever bullets may touch the text ("•Built"); ASCII/dash ones need a
// space after them so "+1 555 0100" and "-5%" stay as written
const BULLET_RE = /^[ \t]*(?:[•▪▫◦●○■□►▸‣⁃∙·]|[*+–—-](?=[ \t])|o(?=[ \t]{2,}))[ \t]*/;

/** True for a line the normalizer marked as a bullet. */
export function isBulletLine(line: string): boolean {
  return /^- \S/.test(line);
}

/** Strip the "- " bullet prefix. */
export function bulletText(line: string): string {
  return line.replace(/^- /, "").trim();
}

/**
 * Normalize extracted résumé text: unify newlines/spaces, rejoin words hyphenated across
 * a line break ("con-\ntributed" → "contributed"), turn bullet glyphs into "- ", and put a
 * space back where PDF extraction glued a date onto the preceding word ("Ltd.July 2023").
 */
export function normalizeResumeText(raw: string): string {
  let s = raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[  -   　]/g, " ")
    .replace(/[​‌‍⁠]/g, "")
    .replace(/\t/g, " ");
  // de-hyphenate: a lower-case word broken at the line end and continued lower-case
  s = s.replace(/([a-z])-\n[ \t]*([a-z])/g, "$1$2");
  const lines = s.split("\n").map((line) => {
    let l = line.replace(/[ ]{2,}/g, " ").trim();
    if (BULLET_RE.test(line) && !/^[-–—]{2,}\s*$/.test(l)) {
      const rest = line.replace(BULLET_RE, "").replace(/[ ]{2,}/g, " ").trim();
      if (rest) l = `- ${rest}`;
    }
    // glued month-year: "Pvt. Ltd.July 2023 – Present" → "Pvt. Ltd. July 2023 – Present"
    l = l.replace(new RegExp(String.raw`([A-Za-z.)])(${MONTH}\.?\s?(?:19|20)\d{2})`, "gi"), (m, a: string, b: string) =>
      // only at a word change: a capitalised month after a lower-case letter, or after "."/")"
      (/^[A-Z]/.test(b) && /[a-z.)]/.test(a)) ? `${a} ${b}` : m,
    );
    // glued trailing year / year range: "Double-entry ledger2024" → "ledger 2024"
    // (not inside a URL/handle/email: "github.com/riley2020" stays intact)
    l = l.replace(
      /(\S*?)([a-z])((?:19|20)\d{2}(?:\s*[–—-]+\s*(?:(?:19|20)\d{2}|present|current))?)$/i,
      (m, head: string, a: string, yr: string) => (/[/@.]/.test(head) ? m : `${head}${a} ${yr}`),
    );
    return l;
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown → plain text, keeping link targets (they carry contact URLs). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^```[\s\S]*?^```/gm, "")
    .split(/\r?\n/)
    .map((line) => {
      let l = line;
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) return ""; // horizontal rule
      l = l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
      l = l.replace(/^\s*>\s?/, "");
      // [text](url): keep the URL when the text doesn't already show it
      l = l.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1");
      l = l.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) => {
        const bare = url.replace(/^mailto:/i, "").replace(/^tel:/i, "");
        const plain = bare.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
        return text.toLowerCase().includes(plain.toLowerCase()) ? text : `${text} (${bare})`;
      });
      l = l.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, (_m, u: string) => u.replace(/^mailto:/i, ""));
      l = l.replace(/(\*\*|__)(.+?)\1/g, "$2");
      l = l.replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1$2");
      l = l.replace(/(^|[\s(])_(?!\s)([^_]+?)_(?=[\s).,;:!?]|$)/g, "$1$2");
      l = l.replace(/`([^`]+)`/g, "$1");
      l = l.replace(/<\/?[a-z][^>]*>/gi, "");
      l = l.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
      // markdown bullets "* x" / "+ x" are normalized later; table pipes → separators
      if (/^\s*\|.*\|\s*$/.test(l)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) return "";
        l = l.replace(/^\s*\|\s*|\s*\|\s*$/g, "").replace(/\s*\|\s*/g, " | ");
      }
      return l.replace(/\s+$/, "");
    })
    .join("\n");
}

/** Read one balanced `{…}` group starting at `i` (which must point at "{"). */
function readGroup(s: string, i: number): { content: string; end: number } | null {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/** Commands whose arguments are layout, not content. */
const LAYOUT_CMDS = new Set([
  "vspace", "hspace", "vskip", "hskip", "setlength", "addtolength", "color", "fontsize", "pagestyle",
  "thispagestyle", "titleformat", "titlespacing", "label", "ref", "pagenumbering", "renewcommand",
  "newcommand", "input", "include", "includegraphics", "fa", "faIcon", "raisebox", "rule", "linespread",
]);
/** Commands whose first argument is a style and the last one the text. */
const TEXT_LAST_ARG = new Set(["textcolor", "colorbox", "fontspec", "parbox", "makebox", "resizebox"]);
/** Formatting commands that take exactly one argument — a following `{…}` is plain text
 *  (`\textbf{Languages}{: Java, Go}` is a label and its list, not a 2-arg macro). */
const ONE_ARG = new Set([
  "textbf", "textit", "emph", "underline", "texttt", "textsc", "textsf", "textrm", "textmd", "textup",
  "section", "subsection", "subsubsection", "paragraph", "item", "small", "large", "Large", "huge", "Huge",
  "footnotesize", "scriptsize", "normalsize", "mbox", "uline", "hl",
]);

/**
 * Pre-pass before `latexToText` for what it can't know: `\href{url}{text}` keeps the URL
 * (contact links), multi-argument template macros (`\resumeSubheading{Title}{Dates}{Company}
 * {Place}`) keep their arguments apart (" | "), TeX dashes become real dashes, and layout
 * commands (`\vspace{-4pt}`) disappear instead of leaving "-4pt" in the text.
 */
export function latexResumeToText(tex: string): string {
  let src = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  const begin = src.indexOf("\\begin{document}");
  if (begin >= 0) src = src.slice(begin);
  let out = latexPrepass(src)
    .replace(/(?<!\\)\$\s*\|\s*\$/g, " | ")
    .replace(/(?<!\\)\$([^$\n]*?)(?<!\\)\$/g, "$1")
    .replace(/(?<!\\)~/g, " ")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/``|''/g, '"');
  if (!out.includes("\\begin{document}")) out = `\\begin{document}\n${out}\n\\end{document}`;
  return latexToText(out)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The structural pass of `latexResumeToText` — output is still LaTeX (escapes intact). */
function latexPrepass(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const m = /^\\([A-Za-z@]+)\*?/.exec(src.slice(i, i + 64));
    if (!m) {
      out += src.slice(i, i + 2); // \\, \&, \% … — latexToText handles these
      i += 2;
      continue;
    }
    const name = m[1]!;
    let j = i + m[0].length;
    const args: string[] = [];
    const maxArgs = ONE_ARG.has(name) ? 1 : Infinity;
    while (args.length < maxArgs) {
      let k = j;
      // TeX lets arguments sit on following lines (\resumeSubheading\n {A}{B}\n {C}{D});
      // an environment's column specs never do, and the group after `\begin{center}\n`
      // is content
      if (name !== "begin" && name !== "end") {
        while (src[k] === " " || src[k] === "\t" || (src[k] === "\n" && src[k + 1] !== "\n")) k++;
      }
      if (src[k] === "[") {
        const close = src.indexOf("]", k);
        if (close < 0) break;
        j = close + 1;
        continue;
      }
      const g = src[k] === "{" ? readGroup(src, k) : null;
      if (!g) break;
      args.push(g.content);
      j = g.end;
    }
    if (name === "begin" || name === "end") {
      // keep the delimiter for latexToText's line breaks; drop tabular column specs
      out += `\\${name}{${args[0] ?? ""}}${name === "begin" ? "\n" : ""}`;
    } else if (LAYOUT_CMDS.has(name)) {
      // layout only — drop it with its arguments
    } else if (name === "href" && args.length >= 2) {
      const url = (args[0] ?? "").replace(/^mailto:/i, "").replace(/^tel:/i, "");
      const text = latexPrepass(args[1] ?? "");
      const plain = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
      const shown = text.replace(/\\[A-Za-z]+\*?|[{}]/g, "");
      out += !plain || shown.toLowerCase().includes(plain.toLowerCase()) ? text : `${text} (${url.replace(/%/g, "\\%")})`;
    } else if (name === "url" && args.length >= 1) {
      out += (args[0] ?? "").replace(/%/g, "\\%");
    } else if (/item/i.test(name) && args.length >= 1) {
      // template bullet macros (\resumeItem{…}, \resumeSubItem{Title}{Detail})
      out += `\n\\item ${args.map(latexPrepass).filter((a) => a.trim()).join(": ")}\n`;
    } else if (TEXT_LAST_ARG.has(name) && args.length >= 2) {
      out += latexPrepass(args[args.length - 1] ?? "");
    } else if (args.length >= 2) {
      const parts = args.map((a) => latexPrepass(a).trim()).filter(Boolean);
      out += `\n${parts.join(" | ")}\n`;
    } else if (args.length === 1) {
      out += `\\${name}{${latexPrepass(args[0] ?? "")}}`;
    } else {
      out += m[0];
    }
    i = j;
  }
  return out;
}

// ── grounding helpers (shared by the parser and `groundDraft`) ──

/** Lower-case, unify dashes/quotes, collapse whitespace — the "verbatim" comparison form. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/×/g, "x")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `needle` appears in `haystack` modulo case/whitespace/dash style. */
export function containsVerbatim(haystack: string, needle: string): boolean {
  const n = normalizeForMatch(needle);
  if (!n) return true;
  return normalizeForMatch(haystack).includes(n);
}

const STOPWORDS = new Set(
  (
    "a an the and or of to in on for with by at from as is are was were be been being it its this that " +
    "these those into over under via per than then so such using used use while across our we i my me " +
    "their they them he she his her you your also both each all any which who whom whose what when where"
  ).split(" "),
);

/** Content tokens of a text (lower-case words/numbers, stopwords and 1-char tokens out). */
export function contentTokens(s: string): string[] {
  return (normalizeForMatch(s).match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? [])
    .map((t) => t.replace(/[.]+$/, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}
