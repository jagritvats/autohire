import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/*
 * Presentational primitives — thin wrappers that only pick class names from globals.css.
 * No state, no data: safe in server and client components alike. The CSS classes are the
 * real contract (see docs/internal/DESIGN.md); these just make the right ones easy to reach.
 */

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "tonal" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** Class string for a button-looking element (use on <a>, <label> for file inputs, etc.). */
export function btn(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string) {
  return cx("btn", `btn--${variant}`, size !== "md" && `btn--${size}`, extra);
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: IconName }) {
  return (
    <button type={type} className={btn(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; iconEnd?: IconName }) {
  return (
    <a className={btn(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={size === "sm" ? 14 : 16} />}
    </a>
  );
}

export type Tone = "neutral" | "accent" | "good" | "info" | "warn" | "bad";

/** Non-interactive label. `estimate` gives the dashed "modeled, not stated" treatment. */
export function Badge({
  tone = "neutral",
  estimate,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; estimate?: boolean }) {
  return (
    <span className={cx("badge", `badge--${tone}`, estimate && "badge--estimate", className)} {...rest}>
      {children}
    </span>
  );
}

/** Toggleable filter/choice pill. Announces its state via aria-pressed. */
export function Chip({
  on,
  tone,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; tone?: "warn" }) {
  return (
    <button
      type={type}
      className={cx("chip", tone === "warn" && "chip--warn", className)}
      data-on={on ? "true" : undefined}
      aria-pressed={on === undefined ? undefined : on}
      {...rest}
    >
      {children}
    </button>
  );
}

const BANNER_ICON: Record<"info" | "warn" | "bad" | "good", IconName> = { info: "info", warn: "warn", bad: "warn", good: "check" };

/** Inline notice. `live` makes it a polite live region (async results, sync state, saves). */
export function Banner({
  tone = "info",
  live,
  title,
  className,
  children,
  action,
}: {
  tone?: "info" | "warn" | "bad" | "good";
  live?: boolean;
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cx("banner", `banner--${tone}`, className)} role={live ? (tone === "bad" ? "alert" : "status") : undefined}>
      <Icon name={BANNER_ICON[tone]} className="banner__icon" />
      <div className="banner__body">
        {title && <strong className="banner__title">{title}</strong>}
        {children}
      </div>
      {action && <div className="banner__action">{action}</div>}
    </div>
  );
}

/** A titled surface (the old `.card-block`). `as` keeps landmarks honest. */
export function Panel({
  title,
  description,
  actions,
  tone,
  id,
  className,
  children,
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "warn" | "bad";
  id?: string;
  className?: string;
  children?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <section id={id} className={cx("panel", tone && `panel--${tone}`, className)} aria-labelledby={id && title ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__heading">
            {title && (
              <H className="panel__title" id={id && title ? `${id}-title` : undefined}>
                {title}
              </H>
            )}
            {description && <p className="panel__desc">{description}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Page title block — every page gets exactly one h1 from here. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {eyebrow && <div className="page-header__eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

/** Labelled form control: wraps the control in a <label> so the association is implicit. */
export function Field({
  label,
  hint,
  className,
  inline,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cx(inline ? "check" : "field", className)}>
      {inline ? (
        <>
          {children}
          <span className="check__label">
            {label}
            {hint && <span className="field__hint">{hint}</span>}
          </span>
        </>
      ) : (
        <>
          <span className="field__label">{label}</span>
          {children}
          {hint && <span className="field__hint">{hint}</span>}
        </>
      )}
    </label>
  );
}

/**
 * The empty state's art, drawn for every style and shown by the ones that use it: Spark draws
 * two soft cards on a tinted blob with a couple of sparkles (the svg); Classic shows only the
 * icon tile; Editorial shows neither (an italic serif line is enough). Inline, theme tokens, no
 * assets, and purely decorative — the title and body say what the place is for.
 */
function EmptyArt({ icon }: { icon: IconName }) {
  return (
    <span className="empty__art" aria-hidden="true">
      <svg viewBox="0 0 176 128" fill="none" focusable="false">
        <path d="M20 78c-6-30 18-58 52-62 22-3 34 8 54 6 22-2 40 14 38 40-2 30-30 52-70 54-40 2-68-10-74-38z" fill="var(--accent-soft)" />
        <g transform="rotate(-9 64 64)">
          <rect x="30" y="30" width="78" height="58" rx="12" fill="var(--surface)" stroke="var(--accent-border)" strokeWidth="1.5" />
          <rect x="42" y="44" width="34" height="6" rx="3" fill="var(--accent-border)" />
          <rect x="42" y="56" width="50" height="5" rx="2.5" fill="var(--surface-3)" />
          <rect x="42" y="66" width="40" height="5" rx="2.5" fill="var(--surface-3)" />
        </g>
        <g transform="rotate(6 104 70)">
          <rect x="64" y="40" width="82" height="62" rx="14" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.5" />
          <circle cx="84" cy="62" r="10" stroke="var(--score-track)" strokeWidth="4" />
          <circle cx="84" cy="62" r="10" stroke="var(--score-great)" strokeWidth="4" strokeLinecap="round" pathLength={100} strokeDasharray="70 100" transform="rotate(-90 84 62)" />
          <rect x="102" y="54" width="32" height="6" rx="3" fill="var(--text-3)" opacity="0.55" />
          <rect x="102" y="65" width="22" height="5" rx="2.5" fill="var(--surface-3)" />
          <rect x="76" y="82" width="26" height="9" rx="4.5" fill="var(--good-soft)" stroke="var(--good-border)" />
          <rect x="106" y="82" width="22" height="9" rx="4.5" fill="var(--spark-soft)" stroke="var(--spark)" strokeOpacity="0.5" />
        </g>
        <path d="M150 22l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="var(--spark)" />
        <path d="M22 26l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z" fill="var(--accent-solid)" opacity="0.8" />
        <circle cx="160" cy="58" r="3" fill="var(--accent-border)" />
        <circle cx="14" cy="96" r="2.5" fill="var(--spark)" opacity="0.7" />
      </svg>
      <span className="empty__icon">
        <Icon name={icon} size={20} />
      </span>
    </span>
  );
}

export function EmptyState({ title, children, action, icon = "search" }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      <EmptyArt icon={icon} />
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/** Loading placeholder. Purely visual — pair with a live region that says "loading". */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx("skeleton-group", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${[92, 76, 58, 84, 64][i % 5]}%` }} />
      ))}
    </div>
  );
}

/** Segmented control for switching views (buttons with aria-pressed — not ARIA tabs, there are no panels). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="segmented__item" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type ScoreBand = "hi" | "mid" | "lo";
/** The score bands every page uses: great ≥ 78, good 60–77, stretch below. */
export const scoreBand = (score: number): ScoreBand => (score >= 78 ? "hi" : score >= 60 ? "mid" : "lo");
export const SCORE_WORD: Record<ScoreBand, string> = { hi: "great", mid: "good", lo: "stretch" };

/**
 * The match score, drawn once for every style; each style's CSS shows the parts it uses:
 * Editorial sets the numeral in display type over a band-coloured rule (the meter), Classic
 * shows the numeral and a meter bar, Spark draws a ring (arc = score) around the numeral and
 * prints the band's word under it. Colour never carries the band alone, and there is one
 * accessible name for the whole thing ("Match score 92 of 100, a great match").
 * `score: null` is the unscored state (no profile yet).
 */
export function ScoreRing({ score, size = "md", className }: { score: number | null; size?: "md" | "lg"; className?: string }) {
  if (score === null) {
    return (
      <div className={cx("match__score", className)} data-band="none" title="Not scored — add your résumé to rank jobs for you">
        <span className={cx("score-ring", `score-ring--${size}`, "score-ring--none")} aria-hidden="true">
          <span className="score-ring__dial">
            <span className="score-num">—</span>
          </span>
          <span className="score-ring__word">unscored</span>
        </span>
        <span className="sr-only">Not scored yet</span>
      </div>
    );
  }
  const band = scoreBand(score);
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div
      className={cx("match__score", className)}
      data-band={band}
      role="img"
      aria-label={`Match score ${score} of 100, a ${SCORE_WORD[band]} match`}
      title="How well this matches your profile (0–100)"
    >
      <span className={cx("score-ring", `score-ring--${size}`)} data-band={band} aria-hidden="true">
        <span className="score-ring__dial">
          <svg viewBox="0 0 44 44" focusable="false">
            <circle className="score-ring__track" cx="22" cy="22" r="18.5" />
            <circle className="score-ring__arc" cx="22" cy="22" r="18.5" pathLength={100} strokeDasharray={`${pct} 100`} />
          </svg>
          <span className="score-num score-ring__num">{score}</span>
        </span>
        <span className="score-ring__word">{SCORE_WORD[band]}</span>
      </span>
      <span className="score-meter" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export function Stat({ value, label, tone, className }: { value: ReactNode; label: ReactNode; tone?: "good" | "muted" | "accent" | "info" | "warn"; className?: string }) {
  return (
    <div className={cx("stat", tone && `stat--${tone}`, className)}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

export { cx };
