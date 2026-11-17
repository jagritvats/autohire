import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { Evidence } from "@jobflow/core";
import type { Ctx } from "../context.js";
import { CliError, EXIT, notFound, usage } from "../errors.js";
import { csv } from "./shared.js";

/**
 * The Evidence Bank — the concrete things you did, in your own words. Every tailored
 * bullet / answer must rest on this, your résumé, or your declared skills (invariant #3),
 * so adding real items here is the best way to get better drafts.
 */
export function register(program: Command, ctx: Ctx): void {
  const ev = program.command("evidence").description("your Evidence Bank: the facts every tailored draft is grounded in");

  ev.command("list", { isDefault: true })
    .alias("ls")
    .description("list evidence items")
    .action(async () => {
      const items = await list(ctx);
      ctx.out.emit(items, () => {
        if (!items.length) {
          ctx.out.line("Your Evidence Bank is empty.");
          ctx.out.hint('Add one: jobflow evidence add --project "Payments ledger" --headline "Built an idempotent ledger" --detail "…" --metric "2M tx/day"');
          return;
        }
        items.forEach((e, i) => {
          ctx.out.line(`${ctx.out.dim(`${String(i + 1).padStart(2)}.`)} ${ctx.out.bold(e.headline)} ${ctx.out.dim(`· ${e.project} · ${e.id.slice(0, 8)}${e.origin === "sample" ? " · SAMPLE (fictional)" : ""}`)}`);
          if (e.detail && e.detail !== e.headline) ctx.out.line(`    ${e.detail}`);
          const meta = [e.metric ? `metric: ${e.metric}` : null, e.tags.length ? `tags: ${e.tags.join(", ")}` : null].filter(Boolean);
          if (meta.length) ctx.out.line(`    ${ctx.out.dim(meta.join(" · "))}`);
        });
      });
    });

  ev.command("add")
    .description("add an item (prompts for anything missing)")
    .option("--project <name>", "where it happened (project / employer)")
    .option("--headline <text>", "one line: what you did")
    .option("--detail <text>", "the specifics, in your own words")
    .option("--metric <text>", "a number that shows the result, if there is one")
    .option("--tags <list>", "skills it shows, comma-separated")
    .action(async (o: { project?: string; headline?: string; detail?: string; metric?: string; tags?: string }) => {
      const project = o.project ?? (await ctx.ask("Project / employer:"));
      const headline = o.headline ?? (await ctx.ask("Headline (what you did, one line):"));
      if (!headline.trim()) throw usage("A headline is required.");
      const detail = o.detail ?? (await ctx.ask("Detail (optional):", headline));
      const metric = o.metric ?? (await ctx.ask("Metric (optional):"));
      const tags = csv(o.tags ?? (await ctx.ask("Tags / skills (optional, comma-separated):"))).map((t) => t.toLowerCase());
      const e: Evidence = {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        project: project.trim(),
        headline: headline.trim(),
        detail: (detail || headline).trim(),
        metric: metric.trim() || null,
        tags,
        embedding: null,
        origin: "manual",
      };
      const repo = await ctx.repo();
      await repo.saveEvidence(e);
      ctx.out.emit(e, () => ctx.out.ok(`Added "${e.headline}" (${e.id.slice(0, 8)})`));
    });

  ev.command("rm")
    .alias("remove")
    .description("remove an item by its number in `evidence list`, or its id / id prefix")
    .argument("<ref>")
    .action(async (ref: string) => {
      const items = await list(ctx);
      const e = pick(items, ref);
      await (await ctx.repo()).deleteEvidence(ctx.tenantId, e.id);
      ctx.out.emit({ ok: true, removed: e.id }, () => ctx.out.ok(`Removed "${e.headline}"`));
    });
}

async function list(ctx: Ctx): Promise<Evidence[]> {
  const items = await (await ctx.repo()).listEvidence(ctx.tenantId);
  return items.map((e) => ({ ...e, embedding: null }));
}

function pick(items: Evidence[], ref: string): Evidence {
  const r = ref.trim().replace(/^#/, "");
  if (/^\d{1,3}$/.test(r)) {
    const e = items[Number(r) - 1];
    if (!e) throw notFound(`There's no evidence item #${r} (you have ${items.length}).`);
    return e;
  }
  const hits = items.filter((e) => e.id.startsWith(r.toLowerCase()));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw notFound(`No evidence item matches "${ref}".`);
  throw new CliError(`"${ref}" matches ${hits.length} items — use more characters.`, EXIT.usage);
}
