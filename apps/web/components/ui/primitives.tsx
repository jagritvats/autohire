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

export function EmptyState({ title, children, action, icon = "search" }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={20} />
      </span>
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

export function Stat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: "good" | "muted" }) {
  return (
    <div className={cx("stat", tone && `stat--${tone}`)}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

export { cx };
