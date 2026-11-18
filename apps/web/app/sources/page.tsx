import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { AppFrame } from "@/components/AppFrame";
import { DiscoveryView } from "@/components/DiscoveryView";
import { SyncPanel } from "@/components/SyncPanel";
import { ButtonLink } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Sources — where JobFlow looks for jobs, whether each source worked, and Sync. */
export default async function SourcesPage() {
  // the viewer must be signed in; the sync panel fetches its own (tenant-scoped) view
  await pageAuth("/sources");
  const repo = await getRepo();
  const companies = await repo.listCompanies();
  return (
    <AppFrame
      title="Sources"
      intro="Where JobFlow looks for jobs. Everything here is public data, fetched politely from your machine."
      actions={
        <ButtonLink href="/companies">All companies ({companies.length}) →</ButtonLink>
      }
    >
      <div className="sources-stack">
        <DiscoveryView />
        <SyncPanel />
      </div>
    </AppFrame>
  );
}
