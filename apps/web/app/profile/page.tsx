import { blankProfile, isOnboarded } from "@jobflow/pipeline";
import { tenantProvider } from "@jobflow/service";
import { isOfflineProvider } from "@jobflow/llm";
import { pageAuth } from "@/lib/auth";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { listSources } from "@/lib/sources";
import { AppFrame } from "@/components/AppFrame";
import { ProfileForm, type GenericDraft } from "@/components/ProfileForm";
import { SectionNav } from "@/components/ui/SectionNav";

export const dynamic = "force-dynamic";

/** Anchors for the profile form — the ids live on ProfileForm's sections. */
const PROFILE_SECTIONS = [
  { id: "resume", label: "Résumé" },
  { id: "contact", label: "Contact" },
  { id: "skills", label: "Skills & level" },
  { id: "prefs", label: "What you want" },
  { id: "about", label: "About you" },
  { id: "evidence", label: "Evidence Bank" },
  { id: "context", label: "Connected context" },
  { id: "answers", label: "Reusable answers" },
];

export default async function ProfilePage() {
  const auth = await pageAuth("/profile");
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const profile = (await repo.getProfile(auth.tenantId)) ?? blankProfile(auth.tenantId);
  const config = await repo.getConfig(auth.tenantId);
  const drafts: GenericDraft[] = (await listTailored(auth.tenantId, null))
    .filter((d) => d.kind !== "resume")
    .map((d) => ({ kind: d.kind, text: d.text, model: d.model }));
  const sources = await listSources(auth.tenantId);
  const onboarded = isOnboarded(profile);

  return (
    <AppFrame
      wide
      title="Profile"
      intro={
        onboarded ? (
          "Who you are to JobFlow. Jobs are ranked against this, and every draft is built from it."
        ) : (
          <>
            Not set up yet — the quickest start is the <a href="/onboarding">guided setup</a> (upload your résumé, check what was found, pick what you
            want). Or fill this in by hand.
          </>
        )
      }
    >
      <div className="settings-layout">
        <SectionNav items={PROFILE_SECTIONS} />
        <ProfileForm
          initialProfile={JSON.parse(JSON.stringify(profile))}
          initialDrafts={drafts}
          initialSources={sources}
          llmReady={!isOfflineProvider(tenantProvider(config))}
        />
      </div>
    </AppFrame>
  );
}
