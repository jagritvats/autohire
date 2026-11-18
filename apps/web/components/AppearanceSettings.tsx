"use client";

import { useEffect, useState } from "react";
import { DEFAULT_STYLE, STYLES, applyStyle, readStyle, type StyleId } from "@/lib/style";
import { Segmented } from "./ui";
import { THEME_EVENT, type Theme } from "@/lib/theme";
import { applyTheme, readTheme } from "./ui/ThemeToggle";

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Settings → Appearance: the visual STYLE (lib/style.ts) and the light/dark theme — two
 * independent choices, both per browser. Each style option shows a small live card drawn in
 * that style's own tokens, so you see it in your current theme before you pick it.
 */
export function AppearanceSettings() {
  const [style, setStyle] = useState<StyleId>(DEFAULT_STYLE);
  const [theme, setTheme] = useState<Theme>("system");
  const [said, setSaid] = useState("");

  useEffect(() => {
    setStyle(readStyle());
    setTheme(readTheme());
    const onTheme = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  const pick = (s: StyleId) => {
    setStyle(s);
    applyStyle(s);
    setSaid(`Style: ${STYLES.find((x) => x.id === s)?.label ?? s}. Saved in this browser.`);
  };

  return (
    <section className="card-block" id="appearance">
      <h2>Appearance</h2>
      <p className="hint">How JobFlow looks in this browser — saved here, not in your account. Everything works the same in every style.</p>

      <fieldset className="appearance__group">
        <legend className="appearance__label">Style</legend>
        <div className="style-options">
          {STYLES.map((s) => (
            <label key={s.id} className="style-option" data-on={style === s.id || undefined}>
              <input className="style-option__input" type="radio" name="jobflow-style" value={s.id} checked={style === s.id} onChange={() => pick(s.id)} />
              <StylePreview style={s.id} />
              <span className="style-option__text">
                <span className="style-option__name">
                  {s.label}
                  {s.id === DEFAULT_STYLE && <span className="style-option__default"> · default</span>}
                </span>
                <span className="style-option__desc">{s.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="appearance__group">
        <span className="appearance__label" id="appearance-theme">
          Theme
        </span>
        <Segmented
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={(t) => {
            applyTheme(t);
            setSaid(`Theme: ${t}.`);
          }}
        />
        <p className="hint">Every style has a light and a dark theme. “System” follows your device; the button in the header switches it too.</p>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </section>
  );
}

/**
 * A tiny, static match card in one style. It's drawn with that style's tokens (scoped by
 * `data-style-preview`), not the live components, so all three can sit side by side.
 */
function StylePreview({ style }: { style: StyleId }) {
  return (
    <span className="style-preview" data-style-preview={style} aria-hidden="true">
      <span className="style-preview__bar">
        <span className="style-preview__brand">
          <span>
            Job<em>Flow</em>
          </span>
        </span>
        <span className="style-preview__nav" />
      </span>
      <span className="style-preview__card">
        <span className="style-preview__score" data-band="hi">
          <svg viewBox="0 0 44 44" focusable="false">
            <circle className="style-preview__track" cx="22" cy="22" r="18.5" />
            <circle className="style-preview__arc" cx="22" cy="22" r="18.5" pathLength={100} strokeDasharray="88 100" />
          </svg>
          <span className="style-preview__num">88</span>
          <span className="style-preview__meter" />
        </span>
        <span className="style-preview__body">
          <span className="style-preview__title">Backend Engineer</span>
          <span className="style-preview__meta">Northwind Labs · Remote</span>
          <span className="style-preview__tags">
            <span className="style-preview__tag style-preview__tag--good">2d</span>
            <span className="style-preview__tag">est. pay</span>
          </span>
        </span>
        <span className="style-preview__btn">Apply</span>
      </span>
    </span>
  );
}
