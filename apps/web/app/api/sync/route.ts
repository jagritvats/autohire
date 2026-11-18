import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";
import { deleteSync, getSync, postSync } from "@/lib/syncApi";

// The corpus sync: GET its status (the polling fallback of /api/sync/stream), POST to start
// one in the background (returns at once — never polls inside the request), DELETE to cancel.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return getSync(await getRepo(), auth);
}

export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return postSync(await getRepo(), auth);
}

export async function DELETE(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return deleteSync(await getRepo(), auth);
}
