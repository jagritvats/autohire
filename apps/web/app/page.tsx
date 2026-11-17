import { getFeed } from "@/lib/feed";
import { pageAuth } from "@/lib/auth";
import { FeedView } from "@/components/FeedView";

// the caller's feed; an empty corpus starts one background sync (never inside the request)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const auth = await pageAuth("/");
  const data = await getFeed(auth.tenantId);
  return <FeedView initial={data} />;
}
