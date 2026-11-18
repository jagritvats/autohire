import type { Command } from "commander";
import { isOnboarded, loadProfile } from "@jobflow/pipeline";
import { rankTenant, runSync } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { EXIT, needsSetup, usage } from "../errors.js";
import { syncProgressView } from "../render/sync-progress.js";

/**
 * `jobflow sync` — discover + poll what your discovery plan names (preset + your sources +
 * saved searches), then rank. The default sweep is the web's background sync
 * (`syncPollOptions`): every due board, most overdue first, inside a time budget, and a quick
 * capped first sync on a fresh registry; `--full` drops the bounds. Cloud-safe Tier 1–2 only
 * (invariant #1). Re-polling upserts idempotently and expires what's gone (invariant #5).
 * Progress is the shared SyncProgress model (service `runSync`): a live display on a TTY,
 * plain lines otherwise, JSON lines on stderr with --json. Ctrl-C cancels cleanly (keeps
 * what was fetched, retires nothing, ranks), a second Ctrl-C quits.
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("sync")
    .description("poll your sources (preset + custom + saved searches), then rank your feed")
    .option("--full", "the full sweep (every due board, slow feeds too, no time limit) — takes a while")
    .option("--max-boards <n>", "poll at most this many boards this run (default: every due board, within a time budget; env JOBFLOW_SYNC_MAX_BOARDS)")
    .action(async (o: { full?: boolean; maxBoards?: string }) => {
      const maxBoards = o.maxBoards == null ? undefined : Number(o.maxBoards);
      if (maxBoards !== undefined && !(Number.isInteger(maxBoards) && maxBoards > 0)) {
        throw usage(`--max-boards takes a positive whole number, not "${o.maxBoards}".`);
      }
      const repo = await ctx.repo();
      const view = syncProgressView(ctx.out);
      // Ctrl-C once: stop starting boards, keep what's fetched, rank it, print the summary.
      // Ctrl-C again: quit now (the default handler).
      const cancel = new AbortController();
      const onSigint = () => {
        if (cancel.signal.aborted) {
          process.off("SIGINT", onSigint);
          view.stop();
          process.kill(process.pid, "SIGINT");
          return;
        }
        cancel.abort();
      };
      process.on("SIGINT", onSigint);
      let result: Awaited<ReturnType<typeof runSync>>;
      try {
        result = await runSync(repo, ctx.tenantId, {
          full: o.full,
          maxBoards,
          trigger: "manual",
          origin: "cli",
          signal: cancel.signal,
          onUpdate: (s) => view.update(s),
          ...(ctx.syncRunner ? { sync: ctx.syncRunner } : {}),
        });
      } finally {
        view.stop();
        process.off("SIGINT", onSigint);
      }
      const { progress: run, stats, ranked, you } = result;
      const matches = ranked ? (await repo.listMatches(ctx.tenantId, 1000)).length : 0;
      const active = (await repo.listActivePostings()).length;
      const secs = Math.round(run.timing.elapsedMs / 1000);
      const fetched = stats?.fetched ?? run.postings.fetched;
      const errors = run.errors;
      ctx.out.emit(
        {
          ...(stats ?? {}),
          status: run.status,
          runId: run.runId,
          ranked,
          matches,
          activePostings: active,
          seconds: secs,
          newPostings: run.postings.new,
          newMatches: you.newMatches,
          strongMatches: you.strongMatches,
          matchThreshold: you.threshold,
          run,
        },
        () => {
          const out = ctx.out;
          const mark = run.status === "done" ? out.green("✓") : out.yellow("!");
          out.line(`${mark} ${run.message ?? ""} (${secs}s)`);
          if (ranked) {
            out.line(
              you.newMatches
                ? `${out.bold(`${you.newMatches} new match${you.newMatches === 1 ? "" : "es"} for you`)} (score ${you.threshold}+${you.strongMatches ? `, ${you.strongMatches} strong` : ""}) · ${matches} ranked in all`
                : `No new matches above ${you.threshold} this time · ${matches} ranked for you in all`,
            );
          }
          const feeds = Object.entries(stats?.feeds ?? {}).filter(([, n]) => n > 0);
          if (feeds.length) out.hint(`feeds: ${feeds.map(([k, n]) => `${k} ${n}`).join(" · ")}`);
          if (stats?.resolved.length) out.hint(`new boards found: ${stats.resolved.slice(0, 8).join(", ")}${stats.resolved.length > 8 ? ", …" : ""}`);
          const left = run.boards.deferred + run.boards.skipped;
          if (left && run.status !== "cancelled") out.hint(`${left} due board(s) wait for the next sync (run \`jobflow sync\` again, or \`--full\` for all of them now).`);
          if (errors.length) {
            out.hint(`${errors.length} source(s) had a problem (each is retried next sync):`);
            for (const e of errors.slice(0, 5)) out.hint(`  ${e.source}: ${e.message}`);
            if (errors.length > 5) out.hint(`  … and ${errors.length - 5} more (\`jobflow sync --json\` lists them)`);
          }
          out.line(`Your corpus: ${active} active postings${ranked ? ` · ${matches} ranked for you` : ""}.`);
          if (!ranked) out.hint("Not ranked yet — set up your profile with `jobflow init` to get scores.");
          else out.hint("next: jobflow feed");
          if (fetched === 0 && run.status === "done") out.warn("Nothing was fetched. If you're online, a proxy or firewall may be blocking the job boards — `jobflow doctor` checks; `jobflow search …` asks other boards.");
        },
      );
      // a sync that reached no source at all failed (scripts branch on it); partial errors are normal
      if (run.status === "failed" || (fetched === 0 && errors.length && run.status === "done")) ctx.exitCode = EXIT.error;
      else if (run.status === "cancelled") ctx.exitCode = EXIT.cancelled;
    });

  program
    .command("rank")
    .description("re-score your feed against your profile (after editing it) — no polling")
    .action(async () => {
      const repo = await ctx.repo();
      const profile = await loadProfile(repo, ctx.tenantId);
      if (!isOnboarded(profile)) {
        throw needsSetup("There's no profile to rank against yet.", "Run `jobflow init` first.");
      }
      const spin = ctx.out.spinner("Ranking against your profile");
      await rankTenant(repo, ctx.tenantId).finally(() => spin.stop());
      const matches = (await repo.listMatches(ctx.tenantId, 1000)).length;
      const active = (await repo.listActivePostings()).length;
      ctx.out.emit({ ok: true, matches, activePostings: active }, () => {
        ctx.out.ok(`Ranked ${matches} of ${active} postings for you.`);
        if (!active) ctx.out.hint("Your corpus is empty — run `jobflow sync` (or `jobflow search … --ingest`).");
        else ctx.out.hint("next: jobflow feed");
      });
    });
}
