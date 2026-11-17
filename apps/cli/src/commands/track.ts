import type { Command } from "commander";
import { ApplicationStatus } from "@jobflow/core";
import { trackApplication } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { usage } from "../errors.js";
import { resolvePosting } from "../refs.js";

/**
 * Your application tracker (the CRM). Statuses: saved → drafting → ready → applied →
 * screening → interviewing → offer | rejected | withdrawn | ghosted. "applied" is only ever
 * set by you — JobFlow never submits, so it can't know.
 */
export function register(program: Command, ctx: Ctx): void {
  const t = program.command("track").description("your applications: list, add, set status, plan the next step");

  t.command("list", { isDefault: true })
    .alias("ls")
    .description("everything you're tracking, next actions first")
    .option("--status <s>", "only this status")
    .action(async (o: { status?: string }) => {
      if (o.status && !ApplicationStatus.safeParse(o.status).success) throw usage(`unknown status "${o.status}"`, `Use: ${ApplicationStatus.options.join(", ")}`);
      const repo = await ctx.repo();
      const apps = (await repo.listApplicationsWithPosting(ctx.tenantId))
        .filter((a) => !o.status || a.status === o.status)
        .sort((a, b) => due(a) - due(b));
      ctx.rememberListing("track", apps.map((a) => a.postingId));
      ctx.out.emit(
        apps.map((a) => ({ ...a, posting: a.posting ? { id: a.posting.id, title: a.posting.title, company: a.posting.companyName, applyUrl: a.posting.applyUrl } : null })),
        () => {
          if (!apps.length) {
            ctx.out.line("Nothing tracked yet.");
            ctx.out.hint("`jobflow apply <ref>` adds a posting as ready; or `jobflow track add <ref>`.");
            return;
          }
          ctx.out.table(
            ["#", "status", "title", "company", "next", "due"],
            apps.map((a, i) => [
              String(i + 1),
              colorStatus(ctx, a.status),
              a.posting?.title ?? "(posting removed)",
              a.posting?.companyName ?? "",
              a.nextAction ?? "",
              a.nextActionAt ? new Date(a.nextActionAt as string | Date).toISOString().slice(0, 10) : "",
            ]),
            { maxWidth: [3, 12, 40, 22, 30, 10] },
          );
          ctx.out.hint("update: jobflow track status 2 interviewing · jobflow track next 2 \"send take-home\" --due 2026-12-01");
        },
      );
    });

  t.command("add")
    .description("start tracking a posting")
    .argument("<ref>")
    .option("--status <s>", "initial status", "saved")
    .action(async (ref: string, o: { status: string }) => {
      const status = parseStatus(o.status);
      const { posting } = await resolvePosting(ctx, ref);
      const repo = await ctx.repo();
      const existing = await repo.getApplicationByPosting(ctx.tenantId, posting.id);
      const app = await trackApplication(repo, ctx.tenantId, posting.id, existing ? {} : { status });
      ctx.out.emit(app, () => ctx.out.ok(`${existing ? "Already tracking" : "Tracking"} ${posting.title} · ${posting.companyName} (${app.status})`));
    });

  t.command("status")
    .description(`set the status: ${ApplicationStatus.options.join(" | ")}`)
    .argument("<ref>")
    .argument("<status>")
    .option("--note <text>", "a note (e.g. who you heard from, the outcome)")
    .action(async (ref: string, s: string, o: { note?: string }) => {
      const status = parseStatus(s);
      const { posting } = await resolvePosting(ctx, ref);
      const app = await trackApplication(await ctx.repo(), ctx.tenantId, posting.id, { status, ...(o.note != null ? { outcome: o.note } : {}) });
      ctx.out.emit(app, () => {
        ctx.out.ok(`${posting.title} · ${posting.companyName}: ${app.status}`);
        if (status === "applied") ctx.out.hint(`Plan the follow-up: jobflow track next ${ref} "follow up" --due ${inDays(7)}`);
      });
    });

  t.command("next")
    .description("set the next action (and optionally when)")
    .argument("<ref>")
    .argument("<action>")
    .option("--due <date>", "YYYY-MM-DD")
    .action(async (ref: string, action: string, o: { due?: string }) => {
      let due: Date | null | undefined;
      if (o.due) {
        due = new Date(o.due);
        if (Number.isNaN(due.getTime())) throw usage(`--due must be a date like 2026-12-01 (got "${o.due}")`);
      }
      const { posting } = await resolvePosting(ctx, ref);
      const app = await trackApplication(await ctx.repo(), ctx.tenantId, posting.id, { nextAction: action, ...(due !== undefined ? { nextActionAt: due } : {}) });
      ctx.out.emit(app, () => ctx.out.ok(`Next for ${posting.companyName}: ${action}${due ? ` (by ${due.toISOString().slice(0, 10)})` : ""}`));
    });
}

function parseStatus(s: string): ApplicationStatus {
  const r = ApplicationStatus.safeParse(s.trim().toLowerCase());
  if (!r.success) throw usage(`unknown status "${s}"`, `Use: ${ApplicationStatus.options.join(", ")}`);
  return r.data;
}

function due(a: { nextActionAt: unknown; status: string }): number {
  const closed = ["rejected", "withdrawn", "ghosted"].includes(a.status) ? 1e15 : 0;
  return closed + (a.nextActionAt ? new Date(a.nextActionAt as string | Date).getTime() : 1e14);
}

function colorStatus(ctx: Ctx, s: string): string {
  if (s === "offer" || s === "interviewing" || s === "screening") return ctx.out.green(s);
  if (s === "applied" || s === "ready") return ctx.out.cyan(s);
  if (s === "rejected" || s === "withdrawn" || s === "ghosted") return ctx.out.dim(s);
  return s;
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}
