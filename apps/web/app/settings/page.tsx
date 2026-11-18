import { toPublicConfig } from "@jobflow/core";
import { tenantProvider } from "@jobflow/service";
import { pageAuth } from "@/lib/auth";
import { getRepo, ensureTenant } from "@/lib/repo";
import { AppFrame } from "@/components/AppFrame";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = await pageAuth("/settings");
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const rawConfig = await repo.getConfig(auth.tenantId);
  // never render the saved LLM key into the page
  const config = rawConfig ? { ...toPublicConfig(rawConfig), llmApiKey: "" } : null;
  const effective = tenantProvider(rawConfig);
  return (
    <AppFrame title="Settings" intro={<>How JobFlow works for you. Your résumé, skills and preferences are under <a href="/profile">Profile</a>.</>}>
      <SettingsForm initialConfig={config} tenantId={auth.tenantId} effectiveModel={effective.name} />
    </AppFrame>
  );
}
