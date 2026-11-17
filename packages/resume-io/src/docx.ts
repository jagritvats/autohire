import { strFromU8, unzipSync } from "fflate";

/**
 * DOCX → text without a Word library: a .docx is a zip whose `word/document.xml` holds
 * paragraphs (`<w:p>`) of runs (`<w:t>`). One paragraph → one line; tabs and line breaks
 * become whitespace; list paragraphs (`<w:numPr>`) get a "- " bullet; table rows join
 * their cells with " | " (the "Company | Dates" layout); hyperlinks keep their target
 * when the visible text doesn't show it (contact URLs). Headers come first — résumés often
 * keep the contact block there.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** `word/_rels/document.xml.rels` → relationship id → external target. */
export function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target && /TargetMode="External"/.test(attrs)) out[id] = decodeXmlEntities(target);
  }
  return out;
}

const TOKEN = /<(\/?)([\w:]+)((?:\s+[\w:]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

/** One WordprocessingML part (document / header / footer) → lines. */
export function wordXmlToLines(xml: string, rels: Record<string, string> = {}): string[] {
  const lines: string[] = [];
  let line = "";
  let bullet = false;
  let inText = false;
  let inPPr = 0;
  let link: { target: string; start: number } | null = null;
  // table state: cells of the current row, paragraphs of the current cell
  let rowDepth = 0;
  let cells: string[] = [];
  let cellParas: string[] = [];

  const endParagraph = () => {
    const parts = line.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
    const text = parts.map((p, i) => (i === 0 && bullet && p.trim() ? `- ${p.trim()}` : p)).join("\n");
    if (rowDepth > 0) cellParas.push(text.replace(/\n/g, " ").trim());
    else lines.push(text);
    line = "";
    bullet = false;
  };

  // text boxes appear twice (DrawingML + a VML fallback copy) — read only the first
  let fallback = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const [, close, tag, attrs = "", selfClose, text] = m;
    if (text !== undefined) {
      if (inText && fallback === 0) line += decodeXmlEntities(text);
      continue;
    }
    if (tag === "mc:Fallback" && !selfClose) {
      fallback += close ? -1 : 1;
      continue;
    }
    if (fallback > 0) continue;
    switch (tag) {
      case "w:p":
        if (selfClose) {
          if (rowDepth === 0) lines.push("");
        } else if (close) endParagraph();
        else {
          line = "";
          bullet = false;
        }
        break;
      case "w:pPr":
        if (!selfClose) inPPr += close ? -1 : 1;
        break;
      case "w:numPr":
        if (inPPr > 0 && !close) bullet = true;
        break;
      case "w:t":
        inText = !close && !selfClose;
        break;
      case "w:tab":
        // <w:tab/> in a run is a tab character; inside <w:pPr><w:tabs> it's a tab stop
        if (inPPr === 0 && !close) line += "\t";
        break;
      case "w:br":
      case "w:cr":
        if (!close) line += "\n";
        break;
      case "w:noBreakHyphen":
        line += "-";
        break;
      case "w:hyperlink":
        if (!close && !selfClose) {
          const id = /r:id="([^"]+)"/.exec(attrs)?.[1];
          const target = id ? rels[id] : undefined;
          link = target ? { target, start: line.length } : null;
        } else if (close && link) {
          const shown = line.slice(link.start).toLowerCase();
          const bare = link.target.replace(/^mailto:/i, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
          if (bare && !shown.includes(bare.toLowerCase())) line += ` (${link.target.replace(/^mailto:/i, "")})`;
          link = null;
        }
        break;
      case "w:tr":
        if (selfClose) break;
        if (!close) {
          rowDepth++;
          cells = [];
        } else {
          rowDepth--;
          const row = cells.filter(Boolean).join(" | ");
          if (row) lines.push(row);
          cells = [];
        }
        break;
      case "w:tc":
        if (selfClose) break;
        if (!close) cellParas = [];
        else cells.push(cellParas.filter(Boolean).join(" "));
        break;
      default:
        break;
    }
  }
  return lines;
}

/** Bytes of a .docx → plain text. Throws when it isn't a Word document. */
export function docxToText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: (f) => /^word\/(document|header\d*|footer\d*)\.xml$|^word\/_rels\/document\.xml\.rels$/.test(f.name),
  });
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("not a Word document (word/document.xml is missing)");
  const rels = files["word/_rels/document.xml.rels"] ? parseRels(strFromU8(files["word/_rels/document.xml.rels"]!)) : {};
  const headers = Object.keys(files)
    .filter((n) => /^word\/header\d*\.xml$/.test(n))
    .sort()
    .flatMap((n) => wordXmlToLines(strFromU8(files[n]!)));
  const body = wordXmlToLines(strFromU8(doc), rels);
  return [...headers, ...body]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
