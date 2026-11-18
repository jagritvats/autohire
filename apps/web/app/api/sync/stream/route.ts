import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";
import { syncStream } from "@/lib/syncApi";

// Live sync progress as server-sent events (the header indicator and the sync panel).
// Clients fall back to polling GET /api/sync when the stream can't be held open.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return syncStream(await getRepo(), auth, req.signal);
}
