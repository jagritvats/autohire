/**
 * Tiny, dependency-free Markdown → HTML for the common-format résumé and the cover letter
 * (§ Customize). PURE (no "server-only", no window) so the client component can import
 * it; TailorView renders these into a preview iframe and prints it → Save-as-PDF. Not a
 * full CommonMark engine — just what a résumé uses (headings, bold/italic/code, links, lists).
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Only web / mail links survive — the text is model output shaped by a job posting. */
function safeHref(u: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u) ? `https://${u}` : null;
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\s][^_]*)_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => {
      const href = safeHref(u.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}">${t}</a>` : t;
    });
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (/^#{3,6}\s+/.test(line)) out.push(`<h3>${inline(line.replace(/^#{3,6}\s+/, ""))}</h3>`);
    else if (/^##\s+/.test(line)) out.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`);
    else if (/^#\s+/.test(line)) out.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`);
    else if (/^---+$/.test(line.trim())) out.push("<hr/>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

function page(title: string, css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html { background: #e9e9e6; }
  body { background: #fff; color: #111; max-width: 8.5in; min-height: 11in; box-sizing: border-box; margin: 16px auto; padding: 0.7in 0.75in; box-shadow: 0 1px 6px rgba(0,0,0,.18); }
  a { color: #0645ad; text-decoration: none; }
  @page { size: auto; margin: 0.6in; }
  @media print { html { background: #fff; } body { margin: 0; padding: 0; max-width: none; min-height: 0; box-shadow: none; } a { color: #111; } }
  ${css}
</style></head><body>${body}</body></html>`;
}

/** A print-ready résumé page (clean résumé styling) around the rendered Markdown. */
export function printableResumeHtml(md: string, title = "Résumé"): string {
  return page(
    title,
    `body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.4; }
  h1 { font-size: 20pt; margin: 0 0 2px; }
  h1 + p, h1 + p + p { margin: 0; color: #333; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: .07em; color: #333; border-bottom: 1px solid #bbb; padding-bottom: 2px; margin: 14px 0 6px; }
  h3 { font-size: 10.5pt; margin: 9px 0 2px; }
  p { margin: 3px 0; } ul { margin: 3px 0; padding-left: 18px; } li { margin: 2px 0; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }`,
    mdToHtml(md),
  );
}

/** A print-ready cover letter page. */
export function printableLetterHtml(text: string, title = "Cover letter"): string {
  return page(
    title,
    `body { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.5; padding-top: 0.9in; }
  p { margin: 0 0 11pt; }`,
    mdToHtml(text),
  );
}
