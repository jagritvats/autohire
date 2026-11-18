import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { tenantProvider } from "@jobflow/service";
import { isOfflineProvider } from "@jobflow/llm";
import { AppFrame } from "@/components/AppFrame";
import { OnboardingWizard } from "@/components/OnboardingWizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const auth = await pageAuth("/onboarding");
  const config = await (await getRepo()).getConfig(auth.tenantId);
  const llmReady = !isOfflineProvider(tenantProvider(config));
  return (
    <AppFrame
      title="Set up your profile"
      intro="Four short steps: JobFlow reads your résumé, you check what it found, then say what you want and where to look. Everything stays on this machine."
      actions={
        <a className="chip" href="/">
          skip for now
        </a>
      }
    >
      <OnboardingWizard llmReady={llmReady} />
    </AppFrame>
  );
}
