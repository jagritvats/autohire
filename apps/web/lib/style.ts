/**
 * The visual STYLE (Settings → Appearance): one component tree, three skins. The style is a
 * `data-style` attribute on <html>, next to the theme's `data-theme` — style × theme, six
 * combinations, each measured for contrast (docs/internal/DESIGN.md, "Styles"). Every style's
 * tokens and component overrides are scoped under its attribute (app/styles/*.css); the
 * structure CSS is shared (app/globals.css).
 *
 * Persisted per browser like the theme: localStorage, applied before first paint by an inline
 * <head> script so there's no flash. The server always renders the default, Editorial.
 */
export type StyleId = "editorial" | "classic" | "spark";

export interface StyleOption {
  id: StyleId;
  label: string;
  /** one line for the Appearance picker */
  description: string;
}

export const STYLES: StyleOption[] = [
  { id: "editorial", label: "Editorial", description: "Paper and ink: a serif for headlines and scores, rules instead of boxes." },
  { id: "classic", label: "Classic", description: "The calm ledger: neutral greys, an indigo accent, cards with a score meter." },
  { id: "spark", label: "Spark", description: "Bright and rounded: violet and coral, score rings, a colourful “today” summary." },
];

export const DEFAULT_STYLE: StyleId = "editorial";
export const STYLE_KEY = "jobflow-style";
export const STYLE_ATTR = "data-style";

export function parseStyle(v: unknown): StyleId {
  return v === "classic" || v === "spark" || v === "editorial" ? v : DEFAULT_STYLE;
}

/**
 * Inline, render-blocking snippet for <head>: applies a saved style before first paint. Only a
 * known, non-default value changes anything — the server-rendered default stays otherwise.
 */
export const STYLE_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem("${STYLE_KEY}");if(s==="classic"||s==="spark")document.documentElement.setAttribute("${STYLE_ATTR}",s)}catch(e){}})();`;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RootLike = Pick<Element, "setAttribute">;

/** The saved style; storage failures (private mode, blocked storage) read as the default. */
export function readStyle(storage: StorageLike | undefined = globalThis.localStorage): StyleId {
  try {
    return parseStyle(storage?.getItem(STYLE_KEY));
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Apply a style now and remember it. The default is stored as "no choice". */
export function applyStyle(style: StyleId, root: RootLike | undefined = globalThis.document?.documentElement, storage: StorageLike | undefined = globalThis.localStorage): void {
  root?.setAttribute(STYLE_ATTR, style);
  try {
    if (style === DEFAULT_STYLE) storage?.removeItem(STYLE_KEY);
    else storage?.setItem(STYLE_KEY, style);
  } catch {
    /* the choice lasts for this page only */
  }
}
