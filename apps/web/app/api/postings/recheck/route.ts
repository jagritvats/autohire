import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { recheckFeed } from "@/lib/feed";

// re-polls live ATS boards → can take a while.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Mass recheck. Body accepts `{ postingIds }` (explicit), `{ companyId }` (all its
 * postings), or neither (every active posting). Re-runs the poller machinery to
 * refetch + bump lastSeen / mark stale, then re-ranks and returns the fresh feed.
 */
export async function POST(req: Request) {
  const repo = await getRepo();
  const body = await req.json().catch(() => ({}));
  let ids: string[] = Array.isArray(body?.postingIds) ? body.postingIds : [];
  if (ids.length === 0 && body?.companyId) {
    ids = (await repo.listPostingsByCompany(body.companyId)).map((p) => p.id);
  }
  if (ids.length === 0) {
    ids = (await repo.listActivePostings()).map((p) => p.id);
  }
  const data = await recheckFeed(ids);
  return NextResponse.json(data);
}
