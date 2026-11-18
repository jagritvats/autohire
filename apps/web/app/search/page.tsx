import { pageAuth } from "@/lib/auth";
import { AppFrame } from "@/components/AppFrame";
import { SearchView } from "@/components/SearchView";

export const dynamic = "force-dynamic";

export default async function SearchPage() {
  await pageAuth("/search");
  return (
    <AppFrame title="Search" intro="Ask the live job boards now. Results are ranked against your profile; save a search to make it a tab on Jobs that refreshes on every sync.">
      <SearchView />
    </AppFrame>
  );
}
