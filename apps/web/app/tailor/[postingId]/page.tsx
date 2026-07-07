import Link from "next/link";
import { notFound } from "next/navigation";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { getRepo, ensureTenant } from "@/lib/repo";
import { listTailored } from "@/lib/tailor";
import { TailorView, type Draft, type TailorPosting } from "@/components/TailorView";

export const dynamic = "force-dynamic";

export default async function TailorPage({ params }: { params: { postingId: string } }) {
  const repo = await getRepo();
  await ensureTenant(repo);
  const posting = await repo.getPosting(params.postingId);
  if (!posting) notFound();

  const [config, drafts] = await Promise.all([
    repo.getConfig(DEFAULT_TENANT),
    listTailored(posting.id),
  ]);
  const llm = config?.llmChoice && config.llmChoice !== "echo" ? config.llmChoice : process.env.LLM_PROVIDER ?? "echo";

  const dto: TailorPosting = {
    id: posting.id,
    title: posting.title,
    company: posting.companyName,
    companyId: posting.companyId,
    applyUrl: posting.applyUrl,
    skills: posting.jdSkills,
    location: posting.location.mode + (posting.location.city ? ` · ${posting.location.city}` : ""),
    level: posting.levelBand,
    llm,
  };

  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ tailor</span>
        </h1>
        <Link className="back" href="/">
          ← feed
        </Link>
      </header>
      <TailorView posting={dto} initialDrafts={drafts as unknown as Draft[]} />
    </div>
  );
}
