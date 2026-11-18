"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountMenu } from "../AccountMenu";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

export const NAV_ITEMS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/", label: "Feed", match: (p) => p === "/" || p.startsWith("/tailor") },
  { href: "/searches", label: "Search", match: (p) => p.startsWith("/searches") },
  { href: "/discovery", label: "Discovery", match: (p) => p.startsWith("/discovery") },
  { href: "/applications", label: "Pipeline", match: (p) => p.startsWith("/applications") },
  { href: "/companies", label: "Registry", match: (p) => p.startsWith("/companies") || p.startsWith("/company/") },
  { href: "/settings", label: "Settings", match: (p) => p.startsWith("/settings") },
];

const BARE = ["/login", "/signup"]; // auth screens: brand + theme only, no app nav

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="JobFlow — home">
      <svg className="brand__mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent-solid)" />
        <path d="M7 15.5h4M7 12h7M7 8.5h10" stroke="var(--accent-on)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="brand__name">JobFlow</span>
    </Link>
  );
}

/** One header for every page: brand, primary nav (a disclosure menu on small screens), account, theme. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const bare = BARE.some((p) => pathname.startsWith(p));
  const [open, setOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuBtn.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <Brand />
          {!bare && (
            <nav className="app-nav" id="app-nav" aria-label="Primary" data-open={open ? "true" : undefined}>
              <ul className="app-nav__list">
                {NAV_ITEMS.map((n) => {
                  const active = n.match(pathname);
                  return (
                    <li key={n.href}>
                      <Link className="app-nav__link" href={n.href} aria-current={active ? "page" : undefined}>
                        {n.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
          <div className="app-header__end">
            {!bare && <AccountMenu />}
            <ThemeToggle />
            {!bare && (
              <button
                ref={menuBtn}
                type="button"
                className="btn btn--ghost btn--icon app-header__menu"
                aria-expanded={open}
                aria-controls="app-nav"
                aria-label={open ? "Close menu" : "Open menu"}
                onClick={() => setOpen((o) => !o)}
              >
                <Icon name={open ? "x" : "menu"} />
              </button>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
