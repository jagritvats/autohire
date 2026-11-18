"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NAV, activeNav } from "@/lib/nav";
import { AccountMenu } from "../AccountMenu";
import { SyncIndicator } from "../SyncIndicator";
import { MARK_DOT, MARK_J, MARK_RX } from "./brandMark";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { useThemeColorMeta } from "./themeColor";

const BARE = ["/login", "/signup"]; // auth screens: brand + theme only, no app nav

/**
 * The JobFlow mark (brand/README.md): a J and a full stop on a tile. JobFlow goes this far and
 * stops; the next move is yours, so the stop is the accent ("you can act here"). It follows
 * every style and theme without its own colours: the tile is the header's ink (currentColor),
 * the J is cut out of it (a mask, so whatever is behind the header shows through — paper,
 * night, Spark's gradient), and the stop is the accent nudged toward the page colour so it
 * stays bright on a dark tile and deep on a light one (a style may name its own stop colour
 * with --brand-mark-dot, as Spark does with its coral).
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  const mask = `jf-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="brand__mark" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
      <mask id={mask}>
        <rect width="100" height="100" fill="#fff" />
        <path d={MARK_J} fill="#000" />
      </mask>
      <rect width="100" height="100" rx={MARK_RX} fill="currentColor" mask={`url(#${mask})`} />
      <circle
        cx={MARK_DOT.cx}
        cy={MARK_DOT.cy}
        r={MARK_DOT.r}
        fill="var(--accent-solid)"
        style={{ fill: "var(--brand-mark-dot, color-mix(in oklab, var(--accent-solid) 78%, var(--bg)))" }}
      />
    </svg>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="JobFlow — home">
      <BrandMark />
      <span className="brand__name">
        Job<em>Flow</em>
      </span>
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
  useThemeColorMeta();
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
            {!bare && <SyncIndicator />}
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
