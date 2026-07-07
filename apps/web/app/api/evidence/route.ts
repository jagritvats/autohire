import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import type { Evidence } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";

export const dynamic = "force-dynamic";

/** The editable Evidence Bank — the citeable spine generation grounds on (§4). */
export async function GET() {
  const repo = await getRepo();
  await ensureTenant(repo);
  return NextResponse.json({ evidence: await repo.listEvidence(DEFAULT_TENANT) });
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
  const repo = await getRepo();
  await ensureTenant(repo);
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const b = parsed.data;
  const entry: Evidence = {
    id: b.id ?? randomUUID(),
    tenantId: DEFAULT_TENANT,
    project: b.project,
    headline: b.headline,
    detail: b.detail,
    metric: b.metric ?? null,
    tags: b.tags,
    embedding: null, // manual entries select by tag overlap; embeddings are optional
  };
  const saved = await repo.saveEvidence(entry);
  return NextResponse.json(saved);
}

/** Delete an evidence entry (?id=). */
export async function DELETE(req: Request) {
  const repo = await getRepo();
  await ensureTenant(repo);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await repo.deleteEvidence(DEFAULT_TENANT, id);
  return NextResponse.json({ ok: true });
}
