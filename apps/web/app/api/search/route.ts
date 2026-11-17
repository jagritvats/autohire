import { NextResponse } from "next/server";
import { z } from "zod";
import { SearchQuery, SourceKind } from "@jobflow/core";
import { makeSearchQuery } from "@jobflow/pipeline";
import { searchJobs } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  /** free text, e.g. `"staff backend" --remote --loc Berlin,DE` (the CLI's syntax) … */
  text: z.string().max(500).optional(),
  /** … or a structured query */
  query: SearchQuery.partial().optional(),
  sources: z.array(SourceKind).max(20).optional(),
  ingest: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sort: z.enum(["score", "relevance"]).optional(),
});

/**
 * Live job search: asks the search-capable Tier 1–2 sources now and scores every result
 * against YOUR profile with the feed's scorer. Read-only unless `ingest` (adds the results
 * to your feed). Tier-3 sites are never searched from the server (invariant #1).
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid search." }, { status: 400 });
  const { text, query, ...opts } = parsed.data;
  const q = query ? SearchQuery.parse(query) : makeSearchQuery(text ?? "");
  const out = await searchJobs(await getRepo(), auth.tenantId, q, opts);
  return NextResponse.json(out);
}
