/**
 * The light/dark THEME — separate from the visual style (lib/style.ts): style × theme.
 * Lives outside the "use client" ThemeToggle so the server layout can inline the init script
 * (a server component importing a constant from a client module gets a client reference,
 * not the string).
 */
export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "jobflow-theme";
/** fired on window when the theme changes, so the header toggle and Settings → Appearance agree */
export const THEME_EVENT = "jobflow:theme";

/**
 * Inline, render-blocking snippet for <head>: applies a saved explicit theme before first
 * paint so there's no flash. "system" = no attribute, the CSS media query decides.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})();`;
