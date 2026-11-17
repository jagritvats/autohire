import Link from "next/link";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { tenantProvider } from "@jobflow/service";
import { isOfflineProvider } from "@jobflow/llm";
import { OnboardingWizard } from "@/components/OnboardingWizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const auth = await pageAuth("/onboarding");
  const config = await (await getRepo()).getConfig(auth.tenantId);
  const llmReady = !isOfflineProvider(tenantProvider(config));
  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ get started</span>
        </h1>
        <nav className="rail-nav" style={{ margin: 0 }}>
          <Link href="/">skip for now</Link>
        </nav>
      </header>
      <OnboardingWizard llmReady={llmReady} />
    </div>
  );
}
