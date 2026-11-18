"use client";

import { useEffect, useState } from "react";
import { THEME_EVENT, THEME_KEY, type Theme } from "@/lib/theme";
import { Icon } from "./Icon";

const ORDER: Theme[] = ["system", "light", "dark"];

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Apply a theme now and remember it ("system" = no attribute, the OS decides). */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode / blocked storage — the choice lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: t }));
}

/** Cycles system → light → dark. Persists per browser; storage failures just don't persist. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    setTheme(readTheme());
    const onTheme = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      onClick={() => applyTheme(next)}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme} (switch to ${next})`}
    >
      <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor"} />
    </button>
  );
}
