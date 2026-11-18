import type { Command } from "commander";
import { setupProgress, type SetupProgress } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { ago } from "../output.js";

/**
 * `jobflow` (no arguments) and `jobflow status`: where you are and the ONE next step,
 * instead of a wall of help (clig.dev: "suggest what to run next"; "provide a command that
 * shows the current state"). The same checklist drives the web app's "Get started" panel.
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("status")
    .description("where you are — profile, jobs, searches, applications, model — and what to do next")
    .action(() => showStatus(ctx));
}

export async function showStatus(ctx: Ctx): Promise<void> {
  const repo = await ctx.repo();
  const p = await setupProgress(repo, ctx.tenantId);
  ctx.out.emit({ ...p, dataDir: ctx.dataDir }, () => render(ctx, p));
}

function render(ctx: Ctx, p: SetupProgress): void {
  const out = ctx.out;
  const ok = out.green("✓");
  const todo = out.dim("○");
  const row = (label: string, value: string) => out.line(`  ${out.dim(label.padEnd(13))}${value}`);

  out.line(`${out.bold("JobFlow")} ${out.dim(`· ${ctx.dataDir}`)}`);
  out.line();

  const pr = p.profile;
  row(
    "profile",
    pr.onboarded
      ? `${pr.name || "(no name yet)"} · ${pr.skills} skill${pr.skills === 1 ? "" : "s"} · ${pr.evidence} evidence item${pr.evidence === 1 ? "" : "s"}${
          pr.missing.length ? out.yellow(` · missing: ${pr.missing.join(", ")}`) : ""
        }`
      : out.yellow("not set up — jobs can't be scored for you yet"),
  );
  const c = p.corpus;
  const synced = c.lastSyncAt ? `last sync ${ago(Math.floor((Date.now() - Date.parse(c.lastSyncAt)) / 86_400_000))}` : "never synced";
  row(
    "jobs",
    c.postings
      ? `${c.postings} posting${c.postings === 1 ? "" : "s"} · ${pr.onboarded ? (c.matches ? "ranked for you" : "not ranked yet (jobflow rank)") : "unscored"} · ${synced}`
      : out.yellow("none yet"),
  );
  row("searches", p.searches ? `${p.searches} saved (they run on every sync)` : out.dim("none saved"));
  const a = p.applications;
  row(
    "applications",
    a.total
      ? `${a.total} tracked · ${a.applied} applied${a.dueFollowUps ? out.yellow(` · ${a.dueFollowUps} follow-up${a.dueFollowUps === 1 ? "" : "s"} due`) : ""}`
      : out.dim("none tracked"),
  );
  row(
    "model",
    p.model.configured
      ? `${p.model.provider} (cover letters, answers and model-written résumés on)`
      : `${out.dim("offline (echo)")} — ranking and résumé templates work; prose needs a model`,
  );
  out.line();

  if (!p.complete) {
    out.line(out.bold(`Getting started ${p.done}/${p.total}`));
    for (const s of p.steps) out.line(`  ${s.done ? ok : todo} ${s.done ? out.dim(s.title) : s.title}`);
    out.line();
  }

  if (p.next) {
    out.line(`${out.bold("Next:")} ${p.next.title.toLowerCase()} — ${p.next.detail}`);
    out.line(`  ${out.cyan(p.next.cli)}`);
    if (p.next.id === "profile") out.hint('  (just exploring? `jobflow init --sample` loads a fictional candidate; `jobflow search "backend"` works without a profile)');
  } else if (a.dueFollowUps) {
    out.line(`${out.bold("Next:")} ${a.dueFollowUps} follow-up${a.dueFollowUps === 1 ? " is" : "s are"} due`);
    out.line(`  ${out.cyan("jobflow track")}`);
  } else {
    out.line(`${out.bold("Next:")} check what's new`);
    out.line(`  ${out.cyan("jobflow sync && jobflow feed")}`);
  }
  out.line();
  out.hint('More: jobflow feed · jobflow search "<what you want>" · jobflow track · jobflow serve (web UI) · jobflow --help');
}
