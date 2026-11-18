"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * The feed's filter rail. A sticky sidebar on wide screens; below the breakpoint it collapses
 * behind a "Filters" button and opens as a modal sheet (Escape / backdrop / close to dismiss,
 * focus moved in and restored). Purely presentational — the filters themselves are children.
 */
export function FilterDrawer({ children, activeCount = 0, label = "Filters" }: { children: ReactNode; activeCount?: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("scroll-locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("scroll-locked");
    };
  }, [open]);

  function close() {
    setOpen(false);
    opener.current?.focus();
  }

  return (
    <>
      <div className="filter-bar">
        <button ref={opener} type="button" className="btn btn--secondary" aria-expanded={open} aria-controls="filter-drawer" onClick={() => setOpen(true)}>
          <Icon name="filter" />
          {label}
          {activeCount > 0 && <span className="count-pill">{activeCount}</span>}
        </button>
      </div>
      {open && <div className="drawer-backdrop" onClick={close} aria-hidden="true" />}
      <aside
        id="filter-drawer"
        className="filter-rail"
        data-open={open ? "true" : undefined}
        aria-label={label}
        ref={panel}
        tabIndex={-1}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
      >
        <div className="filter-rail__head">
          <h2 className="filter-rail__title">
            {label}
            {activeCount > 0 && <span className="count-pill">{activeCount}</span>}
          </h2>
          <button type="button" className="btn btn--ghost btn--icon filter-rail__close" onClick={close} aria-label="Close filters">
            <Icon name="x" />
          </button>
        </div>
        {children}
        <div className="filter-rail__foot">
          <button type="button" className="btn btn--primary btn--block" onClick={close}>
            Show results
          </button>
        </div>
      </aside>
    </>
  );
}
