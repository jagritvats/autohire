/**
 * Tiny, dependency-free Markdown → HTML for the common-format résumé (§ Customize).
 * PURE (no "server-only", no window) so the client component can import it; TailorView
 * feeds printableResumeHtml() into a print window → the user Saves-as-PDF. Not a full
 * CommonMark engine — just what a résumé uses (headings, bold/italic/code, links, lists).
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\s][^_]*)_/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${esc(u)}">${t}</a>`);
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
    if (/^###\s+/.test(line)) out.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`);
    else if (/^##\s+/.test(line)) out.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`);
    else if (/^#\s+/.test(line)) out.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`);
    else if (/^---+$/.test(line.trim())) out.push("<hr/>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** A full, print-ready HTML document (clean résumé styling) around the rendered Markdown. */
export function printableResumeHtml(md: string, name = "résumé"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} — résumé</title>
<style>
  @page { margin: 0.9in; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; line-height: 1.42; max-width: 8.5in; margin: 0 auto; padding: 0.75in; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: #333; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin: 18px 0 8px; }
  h3 { font-size: 13px; margin: 12px 0 4px; }
  p { margin: 4px 0; } ul { margin: 4px 0; padding-left: 20px; } li { margin: 3px 0; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }
  a { color: #0645ad; text-decoration: none; }
  @media print { body { padding: 0; } a { color: #111; } }
</style></head><body>${mdToHtml(md)}</body></html>`;
}
