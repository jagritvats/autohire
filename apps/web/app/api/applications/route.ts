import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApplicationStatus, type Application } from "@jobflow/core";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** CRM list — applications joined with their posting, ordered by next action. */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const apps = await repo.listApplicationsWithPosting(auth.tenantId);
  return NextResponse.json({
    applications: apps.map((a) => ({
      id: a.id,
      postingId: a.postingId,
      status: a.status,
      nextAction: a.nextAction,
      nextActionAt: a.nextActionAt,
      outcome: a.outcome,
      title: a.posting?.title ?? "(posting removed)",
      company: a.posting?.companyName ?? "",
      companyId: a.posting?.companyId ?? null,
      applyUrl: a.posting?.applyUrl ?? null,
      location: a.posting ? `${a.posting.location.mode}` : "",
    })),
  });
}

/** Track a posting (create or fetch its application). Default status 'saved'. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId, status } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  const existing = await repo.getApplicationByPosting(auth.tenantId, postingId);
  const app: Application = existing ?? {
    id: randomUUID(),
    tenantId: auth.tenantId,
    postingId,
    status: ApplicationStatus.parse(status ?? "saved"),
    appliedVia: null,
    tailoredResumeUrl: null,
    resumeVariant: null,
    answers: {},
    submittedAt: null,
    nextAction: null,
    nextActionAt: null,
    outcome: null,
  };
  if (status) app.status = ApplicationStatus.parse(status);
  const saved = await repo.upsertApplication(app);
  return NextResponse.json(saved);
}

/** Update status / next action / outcome from the CRM board. */
export async function PATCH(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const body = await req.json();
  const id = body.id as string | undefined;
  const postingId = body.postingId as string | undefined;
  const current = postingId
    ? await repo.getApplicationByPosting(auth.tenantId, postingId)
    : (await repo.listApplications(auth.tenantId)).find((a) => a.id === id);
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const next: Application = {
    ...current,
    status: body.status ? ApplicationStatus.parse(body.status) : current.status,
    nextAction: body.nextAction !== undefined ? body.nextAction : current.nextAction,
    nextActionAt: body.nextActionAt !== undefined ? body.nextActionAt : current.nextActionAt,
    outcome: body.outcome !== undefined ? body.outcome : current.outcome,
    // tailored drafts → the application; answers shallow-merge so partial saves accrue
    answers: body.answers ? { ...current.answers, ...(body.answers as Record<string, string>) } : current.answers,
    resumeVariant: body.resumeVariant !== undefined ? body.resumeVariant : current.resumeVariant,
    submittedAt: body.status === "applied" && !current.submittedAt ? new Date() : current.submittedAt,
  };
  const saved = await repo.upsertApplication(next);
  return NextResponse.json(saved);
}
