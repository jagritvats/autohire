import { NextResponse } from "next/server";
import { JOB_RUNTIME } from "@jobflow/core";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Mass recheck. Body accepts `{ postingIds }` (explicit), `{ companyId }` (all its
 * postings), or neither (every active posting). Re-polling live ATS boards is slow and
 * Tier 1-2 work, so this ENQUEUES a cloud `recheck` job for the worker to drain (rather
 * than blocking the request). Returns the queued job; the feed refreshes when it lands.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const body = await req.json().catch(() => ({}));
  const postingIds: string[] | undefined = Array.isArray(body?.postingIds) ? body.postingIds : undefined;
  const companyId: string | undefined = typeof body?.companyId === "string" ? body.companyId : undefined;
  const job = await repo.enqueueJob({
    tenantId: auth.tenantId,
    type: "recheck",
    runtime: JOB_RUNTIME["recheck"],
    payload: { postingIds, companyId },
  });
  return NextResponse.json({ queued: true, job });
}
