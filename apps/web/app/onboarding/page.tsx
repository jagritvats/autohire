import Link from "next/link";
import { btn } from "@/components/ui";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { tenantProvider } from "@jobflow/service";
import { isOfflineProvider } from "@jobflow/llm";
import { AppFrame } from "@/components/AppFrame";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { presetChoices } from "@/lib/presets";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const auth = await pageAuth("/onboarding");
  const config = await (await getRepo()).getConfig(auth.tenantId);
  const llmReady = !isOfflineProvider(tenantProvider(config));
  const { options, suggest } = presetChoices();
  return (
    <AppFrame
      title="Set up your profile"
      intro="Four short steps: JobFlow reads your résumé, you check what it found, then say what you want and where to look. Everything stays on this machine."
      actions={
        <Link className={btn("ghost")} href="/">
          skip for now
        </Link>
      }
    >
      <OnboardingWizard llmReady={llmReady} presetOptions={options} suggest={suggest} />
    </AppFrame>
  );
}
