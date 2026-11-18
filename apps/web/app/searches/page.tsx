import { pageAuth } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { SearchView } from "@/components/SearchView";

export const dynamic = "force-dynamic";

export default async function SearchesPage() {
  await pageAuth("/searches");
  return (
    <div className="page">
      <PageHeader title="Search" />
      <SearchView />
    </div>
  );
}
