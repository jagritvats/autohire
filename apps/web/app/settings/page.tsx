import { PageHeader } from "@/components/ui";
import { SectionNav } from "@/components/ui/SectionNav";
import { blankProfile } from "@jobflow/pipeline";
import { toPublicConfig } from "@jobflow/core";
import { pageAuth } from "@/lib/auth";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { listSources } from "@/lib/sources";
import { SettingsForm, type GenericDraft } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

/** Anchors for the long settings form — the ids live on SettingsForm's sections. */
const SETTINGS_SECTIONS = [
  { id: "resume", label: "Base résumé" },
  { id: "about", label: "About you" },
  { id: "context", label: "Connected context" },
  { id: "evidence", label: "Evidence Bank" },
  { id: "stack", label: "Tech stack" },
  { id: "comp", label: "Comp & level" },
  { id: "archetypes", label: "Archetypes" },
  { id: "remote", label: "Remote geo" },
  { id: "locations", label: "Location weights" },
  { id: "contact", label: "Contact" },
  { id: "drafts", label: "Drafts" },
  { id: "cache", label: "Cache & refresh" },
  { id: "model", label: "Generation model" },
  { id: "tokens", label: "API tokens" },
  { id: "automation", label: "Automation" },
];

export default async function SettingsPage() {
  const auth = await pageAuth("/settings");
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const profile = (await repo.getProfile(auth.tenantId)) ?? blankProfile(auth.tenantId);
  const rawConfig = await repo.getConfig(auth.tenantId);
  // never render the saved LLM key into the page
  const config = rawConfig ? { ...toPublicConfig(rawConfig), llmApiKey: "" } : null;
  // generic (no-posting) drafts for the Drafts card
  const drafts: GenericDraft[] = (await listTailored(auth.tenantId, null))
    .filter((d) => d.kind !== "resume")
    .map((d) => ({ kind: d.kind, text: d.text, model: d.model }));
  const sources = await listSources(auth.tenantId);

  return (
    <div className="page page--wide">
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <SectionNav items={SETTINGS_SECTIONS} />
        <SettingsForm
          initialProfile={JSON.parse(JSON.stringify(profile))}
          initialConfig={config}
          initialDrafts={drafts}
          initialSources={sources}
        />
      </div>
    </div>
  );
}
