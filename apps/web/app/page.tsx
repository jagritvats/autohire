import { getFeed } from "@/lib/feed";
import { FeedView } from "@/components/FeedView";

// live ATS polling on first load; memoized for 30m (see lib/feed.ts)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const data = await getFeed();
  return <FeedView initial={data} />;
}
