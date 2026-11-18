import Link from "next/link";
import { PageHeader, btn } from "@/components/ui";
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
    <div className="page">
      <PageHeader
        title="Get started"
        actions={
          <Link className={btn("ghost")} href="/">
            skip for now
          </Link>
        }
      />
      <OnboardingWizard llmReady={llmReady} />
    </div>
  );
}
