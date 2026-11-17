import Link from "next/link";
import { AccountMenu } from "@/components/AccountMenu";
import { pageAuth } from "@/lib/auth";
import { ActivityPanel } from "@/components/ActivityPanel";
import { CompaniesView } from "@/components/CompaniesView";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  await pageAuth("/companies");
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
          <AccountMenu />
        </nav>
      </header>
      <ActivityPanel />
      <CompaniesView />
    </div>
  );
}
