import Link from "next/link";
import { AppFrame } from "@/components/AppFrame";
import { Icon, btn } from "@/components/ui";
import { notFound } from "next/navigation";
import { blankProfile, isSampleEvidence } from "@jobflow/pipeline";
import { pageAuth } from "@/lib/auth";
import { candidateName } from "@jobflow/llm";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { latexEngineAvailable } from "@/lib/latex";
import { TailorView, type Draft, type TailorInputs, type TailorPosting } from "@/components/TailorView";

export const dynamic = "force-dynamic";

export default async function TailorPage({ params }: { params: { postingId: string } }) {
  const auth = await pageAuth(`/tailor/${params.postingId}`);
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const posting = await repo.getPosting(params.postingId);
  if (!posting) notFound();

  const [config, drafts, profile, evidence, texEngine] = await Promise.all([
    repo.getConfig(auth.tenantId),
    listTailored(auth.tenantId, posting.id),
    repo.getProfile(auth.tenantId).then((p) => p ?? blankProfile(auth.tenantId)),
    repo.listEvidence(auth.tenantId),
    latexEngineAvailable(),
  ]);
  const llm = config?.llmChoice && config.llmChoice !== "echo" ? config.llmChoice : process.env.LLM_PROVIDER ?? "echo";
  const model = llm === "echo" ? "" : config?.llmModel || process.env.LLM_MODEL_STRONG || "";

  const dto: TailorPosting = {
    id: posting.id,
    title: posting.title,
    company: posting.companyName,
    companyId: posting.companyId,
    applyUrl: posting.applyUrl,
    skills: posting.jdSkills,
    location: posting.location.mode + (posting.location.city ? ` · ${posting.location.city}` : ""),
    level: posting.levelBand,
    llm: model ? `${llm} · ${model}` : llm,
  };

  // what tailoring will ground on — shown up top so a thin input is visible before generating
  const inputs: TailorInputs = {
    name: candidateName(profile),
    hasEmail: !!profile.prefs.contact.email.trim(),
    resumeChars: profile.masterResume.trim().length,
    hasLatex: !!profile.resumeLatex.trim(),
    aboutChars: profile.aboutText.trim().length,
    skills: profile.prefs.stackProfile.length,
    evidence: evidence.length,
    sampleEvidence: evidence.filter(isSampleEvidence).length,
    offline: llm === "echo",
    texEngine,
  };

  return (
    <AppFrame
      wide
      title={`Tailor for ${posting.title}`}
      eyebrow={
        <Link href={`/jobs/${posting.id}`}>
          <Icon name="arrowLeft" size={14} /> {posting.companyName} · {posting.title}
        </Link>
      }
      intro="Drafts built only from your résumé, Evidence Bank and skills — rephrased for this job, never extended."
      actions={
        <a className={btn("primary")} href={`/jobs/${posting.id}#apply`}>
          Next: apply →
        </a>
      }
    >
      <TailorView posting={dto} inputs={inputs} initialDrafts={drafts as unknown as Draft[]} />
    </AppFrame>
  );
}
