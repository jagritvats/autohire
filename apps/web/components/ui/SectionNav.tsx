"use client";

import { useEffect, useState } from "react";

/**
 * In-page table of contents for long forms (Settings). Sticky column on wide screens, a
 * horizontally scrolling strip on narrow ones; highlights the section in view.
 */
export function SectionNav({ items, label = "On this page" }: { items: Array<{ id: string; label: string }>; label?: string }) {
  const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find((i) => seen.get(i.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: "-72px 0px -55% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);

  return (
    <nav className="section-nav" aria-label={label}>
      <p className="section-nav__label">{label}</p>
      <ul className="section-nav__list">
        {items.map((i) => (
          <li key={i.id}>
            <a className="section-nav__link" href={`#${i.id}`} aria-current={current === i.id ? "location" : undefined} onClick={() => setCurrent(i.id)}>
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
