import type { Command } from "commander";
import { isOnboarded, loadProfile, renormalizeIfStale, renormalizeSummary } from "@jobflow/pipeline";
import { rankTenant } from "@jobflow/service";
import type { Ctx } from "../context.js";

/**
 * `jobflow renormalize` — re-derive stored postings' location + agency flag from their own
 * location text and JD (no polling), then re-rank. `jobflow sync` already does this once
 * whenever the code's NORMALIZE_VERSION is newer than the store's; this is the manual run
 * (after a parser change during development, or to check what it changes). Idempotent.
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("renormalize")
    .description("re-parse stored postings' locations + agency flags with the current parser (no polling), then re-rank")
    .action(async () => {
      const repo = await ctx.repo();
      const spin = ctx.out.spinner("Re-normalizing stored postings");
      const run = await renormalizeIfStale(repo, { force: true }).finally(() => spin.stop());
      let ranked = false;
      if (run?.changed && isOnboarded(await loadProfile(repo, ctx.tenantId))) {
        const s2 = ctx.out.spinner("Ranking against your profile");
        ranked = await rankTenant(repo, ctx.tenantId).finally(() => s2.stop());
      }
      ctx.out.emit({ ...run, ranked }, () => {
        if (!run) return; // forced: always a run
        ctx.out.ok(`Re-normalized: ${renormalizeSummary(run)}`);
        if (run.noRaw) ctx.out.hint(`${run.noRaw} posting(s) predate stored location text; their next poll re-parses them.`);
        if (ranked) ctx.out.hint("Re-ranked your feed. next: jobflow feed");
      });
    });
}
