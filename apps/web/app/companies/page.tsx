import Link from "next/link";
import { ActivityPanel } from "@/components/ActivityPanel";
import { CompaniesView } from "@/components/CompaniesView";

export const dynamic = "force-dynamic";

export default function CompaniesPage() {
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ registry</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">feed</Link>
          <Link href="/companies" data-active="true">registry</Link>
          <Link href="/settings">settings</Link>
        </nav>
      </header>
      <ActivityPanel />
      <CompaniesView />
    </div>
  );
}
