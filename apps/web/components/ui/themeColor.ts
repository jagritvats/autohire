"use client";

import { useEffect } from "react";

/**
 * Keep the browser chrome colour (<meta name="theme-color">) in step with the CURRENT style and
 * theme. layout.tsx ships Editorial's light/dark pair for first paint; once the page runs, this
 * reads the page colour the active style actually uses and re-applies it whenever data-style /
 * data-theme or the OS scheme changes.
 */
export function useThemeColorMeta(): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
      if (!bg) return;
      for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = bg;
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(root, { attributes: true, attributeFilter: ["data-style", "data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", apply);
    };
  }, []);
}
