import Link from "next/link";
import { AccountMenu } from "@/components/AccountMenu";
import { pageAuth } from "@/lib/auth";
import { ApplicationsView } from "@/components/ApplicationsView";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  await pageAuth("/applications");
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ pipeline</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">feed</Link>
          <Link href="/searches">search</Link>
          <Link href="/discovery">discovery</Link>
          <Link href="/applications" data-active="true">pipeline</Link>
          <Link href="/companies">registry</Link>
          <Link href="/settings">settings</Link>
          <AccountMenu />
        </nav>
      </header>
      <ApplicationsView />
    </div>
  );
}
