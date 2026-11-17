import Link from "next/link";
import { blankProfile } from "@jobflow/pipeline";
import { toPublicConfig } from "@jobflow/core";
import { pageAuth } from "@/lib/auth";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { listSources } from "@/lib/sources";
import { SettingsForm, type GenericDraft } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

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
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ settings</span>
        </h1>
        <Link className="back" href="/">
          ← feed
        </Link>
      </header>
      <SettingsForm
        initialProfile={JSON.parse(JSON.stringify(profile))}
        initialConfig={config}
        initialDrafts={drafts}
        initialSources={sources}
      />
    </div>
  );
}
