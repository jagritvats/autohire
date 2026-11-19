import { NextResponse } from "next/server";
import { getJob, JobNotFoundError } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** One job for the caller: card, description, tracker row, drafts and the apply checklist. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    return NextResponse.json(await getJob(await getRepo(), getFileStore(), auth.tenantId, id));
  } catch (e) {
    if (e instanceof JobNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
