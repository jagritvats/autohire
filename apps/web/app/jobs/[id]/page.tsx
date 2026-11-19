import { notFound } from "next/navigation";
import { getJob, JobNotFoundError, type JobDetail } from "@jobflow/service";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { AppFrame } from "@/components/AppFrame";
import { JobView } from "@/components/JobView";
import { Icon } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The Job page — the hub for one role: how you fit, the full description, and the next
 * actions (save, tailor, apply, track) in one place. Every surface links here.
 */
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await pageAuth(`/jobs/${id}`);
  let job: JobDetail;
  try {
    job = await getJob(await getRepo(), getFileStore(), auth.tenantId, id);
  } catch (e) {
    if (e instanceof JobNotFoundError) notFound();
    throw e;
  }
  return (
    <AppFrame
      title={job.card.title}
      eyebrow={
        <a href="/">
          <Icon name="arrowLeft" size={14} /> Jobs
        </a>
      }
      intro={<a href={`/company/${job.card.companyId}`}>{job.card.company}</a>}
    >
      <JobView initial={JSON.parse(JSON.stringify(job))} />
    </AppFrame>
  );
}
