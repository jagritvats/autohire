import { NextResponse } from "next/server";
import { setupProgress } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The caller's first-run checklist + corpus/sync status (the Jobs page polls it while a sync runs). */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json(await setupProgress(await getRepo(), auth.tenantId));
}
