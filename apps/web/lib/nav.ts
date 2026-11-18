/**
 * The app's primary navigation — ordered by the job seeker's loop (find → apply → track),
 * then who you are and where JobFlow looks. Data only; the AppShell (components/ui/AppShell.tsx)
 * renders it — the app's one nav. See docs/internal/UX_AUDIT.md §1.
 */
export interface NavItem {
  href: string;
  label: string;
  /** one line for tooltips / a command palette */
  description: string;
  /** other path prefixes that light this item up (e.g. a job page under Jobs) */
  match?: string[];
}

export const NAV: NavItem[] = [
  { href: "/", label: "Jobs", description: "Your ranked jobs, saved-search views, saved and hidden", match: ["/jobs/", "/tailor/"] },
  { href: "/search", label: "Search", description: "Search the live job boards now and save searches" },
  { href: "/applications", label: "Applications", description: "Where each application stands, and follow-ups" },
  { href: "/profile", label: "Profile", description: "Your résumé, skills, what you want, and evidence", match: ["/onboarding"] },
  { href: "/sources", label: "Sources", description: "Where JobFlow looks: presets, your own sources, companies", match: ["/companies", "/company/"] },
  { href: "/settings", label: "Settings", description: "Pay display, appearance, model, applying, data and tokens" },
];

/** which nav item a pathname belongs to */
export function activeNav(pathname: string): string | null {
  for (const item of NAV) {
    if (item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`)) return item.href;
    if (item.match?.some((m) => pathname.startsWith(m))) return item.href;
  }
  return null;
}
