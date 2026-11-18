"use client";

import "../app/ux.css";
import { usePathname } from "next/navigation";
import { NAV, activeNav } from "@/lib/nav";
import { AccountMenu } from "./AccountMenu";

/**
 * The page frame every screen shares: wordmark, the ONE primary nav (lib/nav.ts), a page
 * title with an optional one-line intro and actions. Structure only — the design system's
 * AppShell can replace this component wholesale; pages pass the same props.
 */
export function AppFrame({
  title,
  intro,
  actions,
  wide,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`settings-shell${wide ? " tailor-shell" : ""}`}>
      <header className="settings-head ux-frame-head">
        <a href="/" className="wordmark" aria-label="JobFlow home">
          Job<span className="flow">Flow</span>
        </a>
        <SiteNav />
      </header>
      <div className="ux-page-head">
        <div>
          <h1 className="ux-page-title">{title}</h1>
          {intro && <p className="hint ux-page-intro">{intro}</p>}
        </div>
        {actions && <div className="ux-page-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const active = activeNav(pathname);
  return (
    <nav className="rail-nav ux-nav" aria-label="Main">
      {NAV.map((n) => (
        <a key={n.href} href={n.href} data-active={active === n.href} aria-current={active === n.href ? "page" : undefined} title={n.description}>
          {n.label}
        </a>
      ))}
      <AccountMenu />
    </nav>
  );
}
