import { NextResponse } from "next/server";
import { z } from "zod";
import { keepSearchResult } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().uuid() });

/**
 * Keep one of YOUR recent search results (held server-side by /api/search — never posted
 * by the client) in the corpus, so it gets a Job page, can be saved, tailored and applied to.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Which result? (id required)" }, { status: 400 });
  const kept = await keepSearchResult(await getRepo(), auth.tenantId, parsed.data.id);
  if (!kept) return NextResponse.json({ error: "That result has expired — run the search again." }, { status: 404 });
  return NextResponse.json({ id: kept.id });
}
