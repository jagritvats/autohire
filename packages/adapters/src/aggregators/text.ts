import { htmlToText } from "../types.js";

/**
 * Search APIs wrap matched terms in inline tags ("<strong>Java</strong>/Spring",
 * "(<b>Node.js</b>)"). Drop those tags outright — `htmlToText` turns every tag into a
 * space, which would read "( Node.js )" — then convert the rest.
 */
export function highlightedToText(s: string | null | undefined): string {
  return htmlToText((s ?? "").replace(/<\/?(b|strong|em|i|mark|span)\b[^>]*>/gi, ""));
}
