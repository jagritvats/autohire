import Link from "next/link";
import { DEFAULT_TENANT, blankProfile } from "@jobflow/pipeline";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { listSources } from "@/lib/sources";
import { SettingsForm, type GenericDraft } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const repo = await getRepo();
  await ensureTenant(repo);
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? blankProfile();
  const config = await repo.getConfig(DEFAULT_TENANT);
  // generic (no-posting) drafts for the Drafts card
  const drafts: GenericDraft[] = (await listTailored(null))
    .filter((d) => d.kind !== "resume")
    .map((d) => ({ kind: d.kind, text: d.text, model: d.model }));
  const sources = await listSources();

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
