import { NextResponse } from "next/server";
import { JOB_RUNTIME } from "@jobflow/core";
import { getRepo, wakeJobRunner } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Remove older entries. Body: `{ olderThanDays, field?: 'lastSeen'|'firstSeen', hard? }`.
 * Soft-deletes (marks stale) by default; `hard: true` deletes the rows. Invalidated
 * postings are never touched (a manual decision outranks age). ENQUEUES a cloud `purge`
 * job (the worker, or this server's runner on the local store) rather than executing
 * synchronously.
 */
export async function POST(req: Request) {
  const auth = await guard(req, { admin: true });
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const body = await req.json().catch(() => ({}));
  const olderThanDays = Number(body?.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    return NextResponse.json({ error: "olderThanDays must be a positive number" }, { status: 400 });
  }
  const field = body?.field === "firstSeen" ? "firstSeen" : "lastSeen";
  const job = await repo.enqueueJob({
    tenantId: auth.tenantId,
    type: "purge",
    runtime: JOB_RUNTIME["purge"],
    payload: { olderThanDays, field, hard: !!body?.hard },
  });
  wakeJobRunner();
  return NextResponse.json({ queued: true, job });
}
