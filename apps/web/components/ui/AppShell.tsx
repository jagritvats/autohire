"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NAV, activeNav } from "@/lib/nav";
import { AccountMenu } from "../AccountMenu";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

const BARE = ["/login", "/signup"]; // auth screens: brand + theme only, no app nav

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="JobFlow — home">
      <span className="brand__name">
        Job<em>Flow</em>
      </span>
      {/* the full stop of a masthead — the one vermilion mark in the header */}
      <svg className="brand__mark" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
        <circle cx="5" cy="5" r="5" fill="var(--accent-solid)" />
      </svg>
    </Link>
  );
}

/**
 * One header for every page: brand, THE primary nav (items + order from lib/nav.ts, see
 * docs/internal/UX_AUDIT.md §1; a disclosure menu on small screens), account, theme.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const bare = BARE.some((p) => pathname.startsWith(p));
  const current = activeNav(pathname);
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
                {NAV.map((n) => {
                  const active = current === n.href;
                  return (
                    <li key={n.href}>
                      <Link className="app-nav__link" href={n.href} aria-current={active ? "page" : undefined} title={n.description}>
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
