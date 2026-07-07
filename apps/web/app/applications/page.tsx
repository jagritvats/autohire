import Link from "next/link";
import { ApplicationsView } from "@/components/ApplicationsView";

export const dynamic = "force-dynamic";

export default function ApplicationsPage() {
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ pipeline</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">feed</Link>
          <Link href="/applications" data-active="true">pipeline</Link>
          <Link href="/companies">registry</Link>
          <Link href="/settings">settings</Link>
        </nav>
      </header>
      <ApplicationsView />
    </div>
  );
}
