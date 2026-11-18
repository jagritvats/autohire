import { setupProgress } from "@jobflow/service";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { AppFrame } from "@/components/AppFrame";
import { DiscoveryView } from "@/components/DiscoveryView";
import { SyncPanel } from "@/components/SyncPanel";

export const dynamic = "force-dynamic";

/** Sources — where JobFlow looks for jobs, whether each source worked, and Sync. */
export default async function SourcesPage() {
  const auth = await pageAuth("/sources");
  const repo = await getRepo();
  const [progress, companies] = await Promise.all([setupProgress(repo, auth.tenantId), repo.listCompanies()]);
  return (
    <AppFrame
      title="Sources"
      intro="Where JobFlow looks for jobs. Everything here is public data, fetched politely from your machine."
      actions={
        <a className="chip" href="/companies">
          All companies ({companies.length}) →
        </a>
      }
    >
      <DiscoveryView />
      <SyncPanel initial={JSON.parse(JSON.stringify(progress))} />
    </AppFrame>
  );
}
