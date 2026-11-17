import Link from "next/link";
import { pageAuth } from "@/lib/auth";
import { AccountMenu } from "@/components/AccountMenu";
import { DiscoveryView } from "@/components/DiscoveryView";

export const dynamic = "force-dynamic";

export default async function DiscoveryPage() {
  await pageAuth("/discovery");
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ discovery</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">feed</Link>
          <Link href="/searches">search</Link>
          <Link href="/discovery" data-active="true">discovery</Link>
          <Link href="/companies">registry</Link>
          <Link href="/settings">settings</Link>
          <AccountMenu />
        </nav>
      </header>
      <DiscoveryView />
    </div>
  );
}
