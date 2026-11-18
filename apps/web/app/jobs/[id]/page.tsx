import { notFound } from "next/navigation";
import { getJob, JobNotFoundError, type JobDetail } from "@jobflow/service";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { AppFrame } from "@/components/AppFrame";
import { JobView } from "@/components/JobView";

export const dynamic = "force-dynamic";

/**
 * The Job page — the hub for one role: how you fit, the full description, and the next
 * actions (save, tailor, apply, track) in one place. Every surface links here.
 */
export default async function JobPage({ params }: { params: { id: string } }) {
  const auth = await pageAuth(`/jobs/${params.id}`);
  let job: JobDetail;
  try {
    job = await getJob(await getRepo(), getFileStore(), auth.tenantId, params.id);
  } catch (e) {
    if (e instanceof JobNotFoundError) notFound();
    throw e;
  }
  return (
    <AppFrame title={job.card.title} intro={<a href={`/company/${job.card.companyId}`}>{job.card.company}</a>}>
      <JobView initial={JSON.parse(JSON.stringify(job))} />
    </AppFrame>
  );
}
