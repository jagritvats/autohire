import { pageAuth } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { DiscoveryView } from "@/components/DiscoveryView";

export const dynamic = "force-dynamic";

export default async function DiscoveryPage() {
  await pageAuth("/discovery");
  return (
    <div className="page">
      <PageHeader title="Discovery" />
      <DiscoveryView />
    </div>
  );
}
