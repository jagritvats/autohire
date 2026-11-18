import type { ReactNode } from "react";
import { PageHeader } from "./ui";

/**
 * The page frame every screen shares: the page container and its ONE h1 (PageHeader), with an
 * optional one-line intro, breadcrumb (eyebrow) and actions. Renders no navigation — the app's
 * single primary nav is the AppShell in app/layout.tsx (items from lib/nav.ts).
 * `wide` gives the wider container (Jobs-style data pages, tailoring side-by-side).
 */
export function AppFrame({
  title,
  intro,
  eyebrow,
  actions,
  wide,
  children,
}: {
  title: ReactNode;
  intro?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? "page page--wide" : "page"}>
      <PageHeader title={title} description={intro} eyebrow={eyebrow} actions={actions} />
      {children}
    </div>
  );
}
