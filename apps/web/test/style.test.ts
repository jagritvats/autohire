import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, STYLES, STYLE_ATTR, STYLE_INIT_SCRIPT, STYLE_KEY, applyStyle, parseStyle, readStyle } from "../lib/style";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { SCORE_WORD, scoreBand } from "../components/ui/primitives";
import { todaySummary } from "../lib/today";

/** a tiny Storage + <html> stand-in, enough for the style code and the head scripts */
function fakeBrowser(saved: Record<string, string> = {}, { broken = false } = {}) {
  const store = new Map(Object.entries(saved));
  const attrs = new Map<string, string>();
  const storage = {
    getItem: (k: string) => {
      if (broken) throw new Error("SecurityError");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => {
      if (broken) throw new Error("SecurityError");
      store.delete(k);
    },
  };
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v) };
  /** run an inline <head> script the way the browser would, before first paint */
  const runHead = (script: string) => new Function("localStorage", "document", script)(storage, { documentElement: root });
  return { store, attrs, storage, root, runHead };
}

describe("visual style (Settings → Appearance)", () => {
  it("offers Editorial (the default), Classic and Spark", () => {
    expect(STYLES.map((s) => s.id)).toEqual(["editorial", "classic", "spark"]);
    expect(DEFAULT_STYLE).toBe("editorial");
    expect(parseStyle("spark")).toBe("spark");
    expect(parseStyle("neon")).toBe("editorial");
    expect(parseStyle(null)).toBe("editorial");
  });

  it("persists a choice and reads it back; the default is stored as no choice", () => {
    const b = fakeBrowser();
    applyStyle("classic", b.root, b.storage);
    expect(b.attrs.get(STYLE_ATTR)).toBe("classic");
    expect(b.store.get(STYLE_KEY)).toBe("classic");
    expect(readStyle(b.storage)).toBe("classic");
    applyStyle("editorial", b.root, b.storage);
    expect(b.attrs.get(STYLE_ATTR)).toBe("editorial");
    expect(b.store.has(STYLE_KEY)).toBe(false);
    expect(readStyle(b.storage)).toBe("editorial");
  });

  it("applies the saved style before first paint (the head script), and ignores junk", () => {
    const spark = fakeBrowser({ [STYLE_KEY]: "spark" });
    spark.runHead(STYLE_INIT_SCRIPT);
    expect(spark.attrs.get("data-style")).toBe("spark");

    // unknown values never reach the attribute — the server-rendered default stays
    const junk = fakeBrowser({ [STYLE_KEY]: '"><script>' });
    junk.runHead(STYLE_INIT_SCRIPT);
    expect(junk.attrs.has("data-style")).toBe(false);
  });

  it("survives blocked storage: the default style, nothing thrown", () => {
    const b = fakeBrowser({}, { broken: true });
    expect(() => b.runHead(STYLE_INIT_SCRIPT)).not.toThrow();
    expect(readStyle(b.storage)).toBe("editorial");
    expect(() => applyStyle("spark", b.root, b.storage)).not.toThrow();
    expect(b.attrs.get(STYLE_ATTR)).toBe("spark"); // this page only
  });

  it("keeps style and theme independent (style × theme)", () => {
    const b = fakeBrowser({ [STYLE_KEY]: "classic", "jobflow-theme": "dark" });
    b.runHead(THEME_INIT_SCRIPT + STYLE_INIT_SCRIPT);
    expect(b.attrs.get("data-style")).toBe("classic");
    expect(b.attrs.get("data-theme")).toBe("dark");
  });

  it("the head scripts are plain strings the server layout can inline", () => {
    // a server component importing a constant from a "use client" module gets a client
    // reference, not the string — so the init scripts must live in plain modules
    expect(typeof STYLE_INIT_SCRIPT).toBe("string");
    expect(typeof THEME_INIT_SCRIPT).toBe("string");
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/from "@\/lib\/theme"/);
    expect(layout).toMatch(/data-style=\{DEFAULT_STYLE\}/);
  });

  it("scopes every style sheet to its own attribute", () => {
    for (const s of STYLES) {
      const css = readFileSync(new URL(`../app/styles/${s.id}.css`, import.meta.url), "utf8");
      const foreign = STYLES.filter((o) => o.id !== s.id).map((o) => `[data-style="${o.id}"]`);
      for (const f of foreign) expect(css.includes(f)).toBe(false);
      expect(css).toContain(`[data-style="${s.id}"]`);
    }
  });
});

describe("score bands (ring colour + word, numeral + rule)", () => {
  it("uses the shared thresholds: great ≥ 78, good 60–77, stretch below", () => {
    expect([92, 78, 77, 60, 59, 0].map(scoreBand)).toEqual(["hi", "hi", "mid", "mid", "lo", "lo"]);
    expect(SCORE_WORD).toEqual({ hi: "great", mid: "good", lo: "stretch" });
  });
});

describe("the Jobs 'today' summary (Editorial's lede, Spark's chips)", () => {
  const card = (id: string, score: number, ageDays: number, extra = {}) => ({ id, title: id, company: "Acme", score, ageDays, ...extra });
  it("counts live jobs by the source's date and names the strongest only when scored", () => {
    const cards = [card("a", 92, 0), card("b", 81, 3), card("c", 55, 10), card("d", 99, 0, { archived: true })];
    const t = todaySummary(cards, true);
    expect(t).toMatchObject({ live: 3, fresh: 1, newThisWeek: 2, great: 2 });
    expect(t.top?.id).toBe("a");
    const u = todaySummary(cards, false);
    expect(u.top).toBeNull();
    expect(u.great).toBe(0);
  });
});
