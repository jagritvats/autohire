import { getFeed } from "@/lib/feed";
import { pageAuth } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { FeedView } from "@/components/FeedView";

// the caller's feed; an empty corpus starts one background sync (never inside the request)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams: { search?: string } }) {
  const auth = await pageAuth("/");
  // `?search=<saved search id>` — your feed through a saved search as an explicit VIEW
  const saved = searchParams.search ? await (await getRepo()).getSavedSearch(auth.tenantId, searchParams.search).catch(() => null) : null;
  const data = await getFeed(auth.tenantId, saved ? { view: saved.id } : {});
  return <FeedView initial={data} viewName={saved?.name ?? null} />;
}
