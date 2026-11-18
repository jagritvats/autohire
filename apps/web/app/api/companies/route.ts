import { NextResponse } from "next/server";
import { normCompany } from "@jobflow/core";
import { atsAdapter, detect } from "@jobflow/adapters";
import { getRepo, wakeJobRunner } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const [companies, counts] = await Promise.all([repo.listCompanies(), repo.postingCountsByCompany()]);
  const rows = companies
    .map((c) => ({
      id: c.id,
      name: c.name,
      atsType: c.atsType,
      atsSlug: c.atsSlug,
      tags: c.tags,
      pollCadence: c.pollCadence,
      status: c.status,
      lastPolled: c.lastPolled,
      postings: counts[c.id] ?? 0,
    }))
    .sort((a, b) => b.postings - a.postings);
  return NextResponse.json({ companies: rows });
}

/** Add a company by name or careers URL → detect ATS board → upsert → enqueue a poll. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { name, careersUrl, tags } = await req.json();
  if (!name && !careersUrl) return NextResponse.json({ error: "name or careersUrl required" }, { status: 400 });

  const det = await detect({ url: careersUrl ?? null, name: name ?? undefined }).catch(() => null);
  const displayName: string = name ?? det?.atsSlug ?? careersUrl;
  const company = await repo.upsertCompany({
    name: displayName,
    nameNorm: normCompany(displayName),
    atsType: det?.atsType ?? "unknown",
    atsSlug: det?.atsSlug ?? null,
    careersUrl: careersUrl ?? null,
    tags: tags ?? ["added"],
    pollCadence: "weekly",
  });

  // if resolved, poll it now via a job
  let job = null;
  if (company.atsType !== "unknown" && company.atsSlug) {
    // a board with no cloud adapter (Darwinbox) is polled by the local agent (invariant #1)
    job = atsAdapter(company.atsType)
      ? await repo.enqueueJob({ tenantId: auth.tenantId, type: "poll", runtime: "cloud", payload: { companyId: company.id } })
      : await repo.enqueueJob({ tenantId: auth.tenantId, type: "local_board_poll", runtime: "local", payload: { companyId: company.id } });
    if (job.runtime === "cloud") wakeJobRunner();
  }
  return NextResponse.json({ company, detection: det, job });
}

/** Update status / cadence (pause, change cadence). */
export async function PATCH(req: Request) {
  const auth = await guard(req, { admin: true });
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { id, status, pollCadence } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await repo.updateCompany(id, { status, pollCadence });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await guard(req, { admin: true });
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await repo.deleteCompany(id);
  return NextResponse.json({ ok: true });
}
