import Link from "next/link";
import { notFound } from "next/navigation";
import { DEFAULT_TENANT, blankProfile, isSampleEvidence } from "@jobflow/pipeline";
import { candidateName } from "@jobflow/llm";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { latexEngineAvailable } from "@/lib/latex";
import { TailorView, type Draft, type TailorInputs, type TailorPosting } from "@/components/TailorView";

export const dynamic = "force-dynamic";

export default async function TailorPage({ params }: { params: { postingId: string } }) {
  const repo = await getRepo();
  await ensureTenant(repo);
  const posting = await repo.getPosting(params.postingId);
  if (!posting) notFound();

  const [config, drafts, profile, evidence, texEngine] = await Promise.all([
    repo.getConfig(DEFAULT_TENANT),
    listTailored(posting.id),
    repo.getProfile(DEFAULT_TENANT).then((p) => p ?? blankProfile()),
    repo.listEvidence(DEFAULT_TENANT),
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
    <div className="settings-shell tailor-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ tailor</span>
        </h1>
        <Link className="back" href="/">
          ← feed
        </Link>
      </header>
      <TailorView posting={dto} inputs={inputs} initialDrafts={drafts as unknown as Draft[]} />
    </div>
  );
}
