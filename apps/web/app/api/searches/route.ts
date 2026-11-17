import { NextResponse } from "next/server";
import { z } from "zod";
import { SearchQuery } from "@jobflow/core";
import { makeSearchQuery } from "@jobflow/pipeline";
import { deleteSearch, listSearches, runSearchNow, saveSearch } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Your saved searches. */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ searches: await listSearches(await getRepo(), auth.tenantId) });
}

const Op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("save"),
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(80),
    text: z.string().max(500).optional(),
    query: SearchQuery.partial().optional(),
    asSource: z.boolean().optional(),
    asView: z.boolean().optional(),
    cadence: z.enum(["daily", "weekly", "manual"]).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ op: z.literal("delete"), id: z.string().uuid() }),
  z.object({ op: z.literal("run"), id: z.string().uuid() }),
]);

/** Create/update, delete or run (ingest now + re-rank) a saved search. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Op.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const repo = await getRepo();
  const b = parsed.data;
  try {
    if (b.op === "delete") {
      await deleteSearch(repo, auth.tenantId, b.id);
      return NextResponse.json({ ok: true });
    }
    if (b.op === "run") return NextResponse.json(await runSearchNow(repo, auth.tenantId, b.id));
    const query = b.query ? SearchQuery.parse(b.query) : makeSearchQuery(b.text ?? "");
    const saved = await saveSearch(repo, auth.tenantId, { ...b, query });
    return NextResponse.json({ search: saved });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
