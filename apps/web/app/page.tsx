import { getFeed } from "@/lib/feed";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { setupProgress } from "@jobflow/service";
import { FeedView } from "@/components/FeedView";

// the caller's Jobs page; an empty corpus starts one background sync (never inside the request)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; search?: string }> }) {
  const auth = await pageAuth("/");
  const repo = await getRepo();
  // `?view=<saved search id>` (or the older `?search=`) opens Jobs on that saved-search tab
  const sp = await searchParams;
  const viewId = sp.view ?? sp.search ?? null;
  const searches = (await repo.listSavedSearches(auth.tenantId)).filter((s) => s.asView);
  const view = viewId ? searches.find((s) => s.id === viewId) ?? null : null;
  const data = await getFeed(auth.tenantId);
  const viewData = view ? await getFeed(auth.tenantId, { view: view.id, bootstrap: false }) : null;
  const progress = await setupProgress(repo, auth.tenantId);
  return (
    <FeedView
      initial={JSON.parse(JSON.stringify(data))}
      initialView={view?.id ?? null}
      initialViewData={viewData ? JSON.parse(JSON.stringify(viewData)) : null}
      views={searches.map((s) => ({ id: s.id, name: s.name }))}
      progress={JSON.parse(JSON.stringify(progress))}
    />
  );
}
