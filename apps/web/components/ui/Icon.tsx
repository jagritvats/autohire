/**
 * A tiny inline icon set (1.75px strokes on a 24px grid, Lucide-style geometry) so the UI
 * doesn't depend on whatever glyphs the fallback font happens to have. Decorative by
 * default — pass `label` when the icon is the only content of a control.
 */
const PATHS = {
  arrowUpRight: "M7 17 17 7M8 7h9v9",
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
  archive: "M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4",
  unarchive: "M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 17v-6M9 13.5l3-3 3 3",
  ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  check: "M20 6 9 17l-5-5",
  chevronDown: "m6 9 6 6 6-6",
  filter: "M3 5h18M6 12h12M10 19h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  pencil: "M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  plus: "M12 5v14M5 12h14",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  restore: "M3 12a9 9 0 1 0 2.6-6.4M3 3v6h6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  warn: "M12 3 2 20h20zM12 10v4M12 17.5v.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01",
  x: "M18 6 6 18M6 6l12 12",
  dot: "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === "bookmark" || name === "dot" ? "var(--icon-fill, none)" : "none"}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
