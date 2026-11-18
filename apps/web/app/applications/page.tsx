import { pageAuth } from "@/lib/auth";
import { ApplicationsView } from "@/components/ApplicationsView";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  await pageAuth("/applications");
  return (
    <div className="page page--wide">
      <PageHeader title="Pipeline" />
      <ApplicationsView />
    </div>
  );
}
