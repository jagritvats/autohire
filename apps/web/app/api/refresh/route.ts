import { NextResponse } from "next/server";
import { refreshFeed, rerankOnly } from "@/lib/feed";
import { corpusSyncing, rankTenant, startCorpusSync } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

// Force a fresh poll of the live ATS/aggregator sources (Tier 1-2 only) + re-rank.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  // `?background=1`: start (or join) ONE background sync and return at once — the page
  // shows progress by polling /api/progress instead of holding a request open for minutes
  if (new URL(req.url).searchParams.get("background") === "1") {
    if (auth.role !== "admin") return NextResponse.json({ started: false, syncing: corpusSyncing(), error: "Syncing the shared job list is an admin action here; your Jobs re-rank after each scheduled sync." }, { status: 403 });
    const repo = await getRepo();
    void startCorpusSync(repo, async () => void (await rankTenant(repo, auth.tenantId)));
    return NextResponse.json({ started: true, syncing: true });
  }
  // re-polling the shared corpus is an admin action on a multi-user instance; members re-rank
  const data = auth.role === "admin" ? await refreshFeed(auth.tenantId) : await rerankOnly(auth.tenantId);
  return NextResponse.json(data);
}
