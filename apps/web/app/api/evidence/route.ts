import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Evidence } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The editable Evidence Bank — the citeable spine generation grounds on (§4). */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  return NextResponse.json({ evidence: await repo.listEvidence(auth.tenantId) });
}

const Body = z.object({
  id: z.string().optional(),
  project: z.string().default(""),
  headline: z.string().default(""),
  detail: z.string().default(""),
  metric: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
});

/** Upsert an evidence entry (create when id is absent, edit when present). */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const b = parsed.data;
  const entry: Evidence = {
    id: b.id ?? randomUUID(),
    tenantId: auth.tenantId,
    project: b.project,
    headline: b.headline,
    detail: b.detail,
    metric: b.metric ?? null,
    tags: b.tags,
    embedding: null, // manual entries select by tag overlap; embeddings are optional
    origin: "manual", // written/edited by the user in the editor
  };
  const saved = await repo.saveEvidence(entry);
  return NextResponse.json(saved);
}

/** Delete an evidence entry (?id=). */
export async function DELETE(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await repo.deleteEvidence(auth.tenantId, id);
  return NextResponse.json({ ok: true });
}
