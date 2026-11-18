import { PayDisplay, activeFx, resolveDisplayCurrency, toPublicConfig } from "@jobflow/core";
import { loadFxRates } from "@jobflow/pipeline";
import { tenantProvider } from "@jobflow/service";
import { pageAuth } from "@/lib/auth";
import { getRepo, ensureTenant } from "@/lib/repo";
import { AppFrame } from "@/components/AppFrame";
import { SettingsForm } from "@/components/SettingsForm";
import { PayDisplayForm } from "@/components/PayDisplayForm";
import { SectionNav } from "@/components/ui/SectionNav";

export const dynamic = "force-dynamic";

/** Anchors for the settings form — the ids live on SettingsForm's sections. */
const SETTINGS_SECTIONS = [
  { id: "pay", label: "Pay display" },
  { id: "model", label: "Writing model" },
  { id: "applying", label: "Applying & local agent" },
  { id: "data", label: "Data" },
  { id: "tokens", label: "API tokens" },
];

export default async function SettingsPage() {
  const auth = await pageAuth("/settings");
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const rawConfig = await repo.getConfig(auth.tenantId);
  // never render the saved LLM key into the page
  const config = rawConfig ? { ...toPublicConfig(rawConfig), llmApiKey: "" } : null;
  const effective = tenantProvider(rawConfig);
  // "show pay in" lives with the tenant's profile prefs
  const prefs = (await repo.getProfile(auth.tenantId))?.prefs;
  const homeCurrency = resolveDisplayCurrency({ ...(prefs ?? {}), display: { currency: "auto", period: "year" } });
  await loadFxRates(repo).catch(() => null);
  return (
    <AppFrame
      wide
      title="Settings"
      intro={
        <>
          How JobFlow works for you. Your résumé, skills and preferences are under <a href="/profile">Profile</a>; where it looks is under{" "}
          <a href="/sources">Sources</a>.
        </>
      }
    >
      <div className="settings-layout">
        <SectionNav items={SETTINGS_SECTIONS} />
        <div>
          <PayDisplayForm initial={PayDisplay.parse(prefs?.display ?? {})} homeCurrency={homeCurrency} rateDate={activeFx().asOf} />
          <SettingsForm initialConfig={config} tenantId={auth.tenantId} effectiveModel={effective.name} />
        </div>
      </div>
    </AppFrame>
  );
}
