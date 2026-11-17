import type { Command } from "commander";
import { isOnboarded, loadProfile } from "@jobflow/pipeline";
import { findSearch, getFeed, listTailored, toCards } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { notFound, usage } from "../errors.js";
import { ago } from "../output.js";
import { compLabel, locationLabel, printCards, renderCard } from "../render/card.js";
import { resolvePosting } from "../refs.js";
import { presetIds } from "./shared.js";
import type { SearchQueryInput } from "@jobflow/core";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("feed")
    .description("your ranked feed (from `jobflow sync`), best first")
    .option("-n, --limit <n>", "how many", "20")
    .option("--min-score <n>", "only matches scoring at least this")
    .option("--search <name>", "view through a saved search (what it hides is counted)")
    .option("--preset <presets>", "only roles tagged with these discovery presets, e.g. india or us,eu-uk")
    .option("--tag <presets>", "same as --preset")
    .option("--format <fmt>", "cards (default) | table")
    .action(async (o: { limit: string; minScore?: string; search?: string; preset?: string; tag?: string; format?: string }) => {
      const repo = await ctx.repo();
      const limit = Math.max(1, Math.min(500, Number(o.limit) || 20));
      const min = o.minScore != null ? Number(o.minScore) : null;
      if (min != null && !Number.isFinite(min)) throw usage("--min-score must be a number");
      const presets = presetIds([o.preset, o.tag].filter((x): x is string => !!x));
      let view: string | SearchQueryInput | null = null;
      if (o.search) {
        const s = await findSearch(repo, ctx.tenantId, o.search);
        if (!s) throw notFound(`No saved search "${o.search}".`, "See them with `jobflow searches`.");
        view = presets.length ? { ...s.query, presets } : s.id;
      } else if (presets.length) view = { presets };
      const data = await getFeed(repo, ctx.tenantId, { limit: Math.max(limit * 4, 100), view, bootstrap: false });
      const scored = data.stats.mode === "ranked";
      const cards = data.cards.filter((c) => !c.archived && (min == null || c.score >= min)).slice(0, limit);
      ctx.rememberListing("feed", cards.map((c) => c.id));
      ctx.out.emit({ cards, stats: data.stats }, () => {
        const out = ctx.out;
        if (!data.stats.postings) {
          out.line("Your corpus is empty.");
          out.hint('Fill it: jobflow sync   (or search live: jobflow search "backend engineer" --remote)');
          return;
        }
        if (!scored) out.line(out.yellow("Browse mode — these aren't scored yet. Set up your profile with `jobflow init` to rank them for you."));
        if (!cards.length) {
          out.line(min != null ? `No matches at ${min}+ yet.` : "No matches yet.");
          out.hint(scored ? "Run `jobflow sync` for more postings, or `jobflow rank` after a profile change." : "");
          return;
        }
        const polled = data.stats.lastPolledAt ? ` · last sync ${ago(Math.floor((Date.now() - Date.parse(data.stats.lastPolledAt)) / 86_400_000))}` : "";
        out.line(out.dim(`top ${cards.length}${scored ? " for you" : " (freshest)"} · ${data.stats.postings} postings in your corpus${polled}`));
        out.line();
        printCards(out, cards, { scored, format: o.format });
        if (data.stats.hiddenTotal) {
          const h = Object.entries(data.stats.hidden ?? {}).filter(([, n]) => n > 0);
          const what = [o.search ? `"${o.search}"` : null, presets.length ? presets.map((p) => `#${p}`).join(" ") : null].filter(Boolean).join(" + ");
          out.hint(`${what} hid ${data.stats.hiddenTotal}: ${h.map(([k, n]) => `${k} ${n}`).join(", ")}`);
        }
        out.hint("next: jobflow show 1 · jobflow tailor 1 · jobflow apply 1");
      });
    });

  program
    .command("show")
    .description("one posting in detail")
    .argument("<ref>", "row number from the last listing, posting id, or id prefix")
    .option("--jd", "print the full job description")
    .action(async (ref: string, o: { jd?: boolean }) => {
      const repo = await ctx.repo();
      const { posting, kept } = await resolvePosting(ctx, ref);
      const profile = await loadProfile(repo, ctx.tenantId);
      const scored = isOnboarded(profile);
      const match = (await repo.listMatchesForPostings(ctx.tenantId, [posting.id]))[0] ?? null;
      const [card] = await toCards(repo, ctx.tenantId, [{ posting, match }]);
      const app = await repo.getApplicationByPosting(ctx.tenantId, posting.id);
      const drafts = await listTailored(repo, ctx.tenantId, posting.id).catch(() => []);
      ctx.out.emit(
        { card, posting: { ...posting, jdEmbedding: undefined }, match, application: app, drafts: drafts.map((d) => ({ kind: d.kind, source: d.source, stale: d.stale, createdAt: d.createdAt })) },
        () => {
          const out = ctx.out;
          if (kept) out.hint("(saved this search result to your corpus)");
          out.line(renderCard(out, card!, 1, { scored: scored && !!match }).replace(/^\s*1\.\s/, "   "));
          out.line();
          const kv = (k: string, v: string | null | undefined) => v && out.line(`  ${out.dim(k.padEnd(11))} ${v}`);
          kv("id", posting.id);
          kv("location", `${locationLabel(card!)}${posting.location.confidence < 0.6 ? out.dim(" (uncertain)") : ""}`);
          kv("pay", compLabel(card!) ?? "not stated");
          if (card!.comp?.estimate && card!.comp.basis) kv("", out.dim(card!.comp.basis));
          kv("skills", posting.jdSkills.join(", "));
          const must = posting.requirements.filter((r) => r.strength === "must_have").map((r) => r.skill);
          if (must.length) kv("must-haves", must.slice(0, 6).join(" · "));
          kv("source", `${posting.source} (${posting.atsType}) · first seen ${new Date(posting.firstSeen as string | Date).toISOString().slice(0, 10)}`);
          kv("tracker", app ? `${app.status}${app.nextAction ? ` · next: ${app.nextAction}` : ""}` : "not tracked");
          if (drafts.length) kv("drafts", drafts.map((d) => `${d.kind}${d.source === "builtin" ? " (builtin)" : ""}${d.stale ? " (stale)" : ""}`).join(", "));
          kv("apply", posting.applyUrl ?? "(no apply link)");
          if (o.jd) {
            out.line();
            out.line(posting.jdText || out.dim("(no description)"));
          } else if (posting.jdText) out.hint("full description: add --jd");
        },
      );
    });
}
