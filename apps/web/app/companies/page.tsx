import { pageAuth } from "@/lib/auth";
import { ActivityPanel } from "@/components/ActivityPanel";
import { CompaniesView } from "@/components/CompaniesView";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  await pageAuth("/companies");
  return (
    <div className="page page--wide">
      <PageHeader title="Registry" />
      <ActivityPanel />
      <CompaniesView />
    </div>
  );
}
