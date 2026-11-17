import Link from "next/link";
import { pageAuth } from "@/lib/auth";
import { AccountMenu } from "@/components/AccountMenu";
import { SearchView } from "@/components/SearchView";

export const dynamic = "force-dynamic";

export default async function SearchesPage() {
  await pageAuth("/searches");
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ search</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">feed</Link>
          <Link href="/searches" data-active="true">search</Link>
          <Link href="/discovery">discovery</Link>
          <Link href="/applications">pipeline</Link>
          <Link href="/settings">settings</Link>
          <AccountMenu />
        </nav>
      </header>
      <SearchView />
    </div>
  );
}
