import type { Command } from "commander";
import { isOnboarded, loadProfile, pollAll } from "@jobflow/pipeline";
import { rankTenant, syncPollOptions } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { EXIT, needsSetup, usage } from "../errors.js";

/**
 * `jobflow sync` — discover + poll what your discovery plan names (preset + your sources +
 * saved searches), then rank. The default sweep is the web's background sync
 * (`syncPollOptions`): every due board, most overdue first, inside a time budget, and a quick
 * capped first sync on a fresh registry; `--full` drops the bounds. Cloud-safe Tier 1–2 only
 * (invariant #1). Re-polling upserts idempotently and expires what's gone (invariant #5).
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
      const started = Date.now();
      const spin = ctx.out.spinner(o.full ? "Full sync — polling every due board and feed" : "Syncing — polling boards and feeds");
      let lines = 0;
      const log = (m: string) => {
        lines++;
        spin.update(`${o.full ? "Full sync" : "Syncing"} · ${m.replace(/\s+/g, " ").slice(0, 90)}`);
      };
      // the same sweep as service `syncCorpus`, with progress reported
      const stats = await pollAll(repo, syncPollOptions({ full: o.full, maxBoards, log })).finally(() => spin.stop());
      const profile = await loadProfile(repo, ctx.tenantId);
      let ranked = false;
      if (isOnboarded(profile)) {
        const s2 = ctx.out.spinner("Ranking against your profile");
        ranked = await rankTenant(repo, ctx.tenantId).finally(() => s2.stop());
      }
      const matches = ranked ? (await repo.listMatches(ctx.tenantId, 1000)).length : 0;
      const active = (await repo.listActivePostings()).length;
      const secs = Math.round((Date.now() - started) / 1000);
      ctx.out.emit({ ...stats, ranked, matches, activePostings: active, seconds: secs, progressLines: lines }, () => {
        const out = ctx.out;
        const feeds = Object.entries(stats.feeds).filter(([, n]) => n > 0);
        out.ok(`Polled ${stats.companiesPolled} board(s) + ${Object.keys(stats.feeds).length} feed(s): ${stats.fetched} postings fetched, ${stats.staled} gone, ${stats.expired} expired (${secs}s)`);
        if (feeds.length) out.hint(`feeds: ${feeds.map(([k, n]) => `${k} ${n}`).join(" · ")}`);
        if (stats.resolved.length) out.hint(`new boards found: ${stats.resolved.slice(0, 8).join(", ")}${stats.resolved.length > 8 ? ", …" : ""}`);
        if (stats.boardsDeferred) out.hint(`${stats.boardsDeferred} of ${stats.boardsDue} due boards wait for the next sync (run \`jobflow sync\` again, or \`--full\` for all of them now).`);
        if (stats.errors.length) out.hint(`${stats.errors.length} error(s), e.g. ${stats.errors.slice(0, 2).join("; ")}`);
        out.line(`Your corpus: ${active} active postings${ranked ? ` · ${matches} ranked for you` : ""}.`);
        if (!ranked) out.hint("Not ranked yet — set up your profile with `jobflow init` to get scores.");
        else out.hint("next: jobflow feed");
        if (stats.fetched === 0) out.warn("Nothing was fetched. If you're online, a proxy or firewall may be blocking the job boards — `jobflow doctor` checks; `jobflow search …` asks other boards.");
      });
      // a sync that reached no source at all failed (scripts branch on it); partial errors are normal
      if (stats.fetched === 0 && stats.errors.length) ctx.exitCode = EXIT.error;
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
