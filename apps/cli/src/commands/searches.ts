import type { Command } from "commander";
import { deleteSearch, findSearch, listSearches, runSearchNow, saveSearch } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { notFound, usage } from "../errors.js";
import { addQueryOptions, buildQuery, describeQuery, type QueryOpts } from "./search.js";

/**
 * Saved searches: each one (a) drives the search-capable sources on every `jobflow sync`
 * and (b) is a view over your feed (`jobflow feed --search <name>`), with hidden counts.
 */
export function register(program: Command, ctx: Ctx): void {
  const s = program.command("searches").description("saved searches: run on every sync, and usable as feed views");

  s.command("list", { isDefault: true })
    .alias("ls")
    .description("list saved searches")
    .action(async () => {
      const all = await listSearches(await ctx.repo(), ctx.tenantId);
      ctx.out.emit(all, () => {
        if (!all.length) {
          ctx.out.line("No saved searches.");
          ctx.out.hint('Add one: jobflow searches add go-remote "golang" --remote   (or: jobflow search … --save-as <name>)');
          return;
        }
        ctx.out.table(
          ["name", "query", "last run", "enabled"],
          all.map((x) => [
            x.name,
            describeQuery(x.query),
            x.lastRunAt ? new Date(x.lastRunAt as string | Date).toISOString().slice(0, 16).replace("T", " ") : "never",
            x.enabled ? "yes" : "no",
          ]),
          { maxWidth: [24, 60, 16, 7] },
        );
      });
    });

  const add = s
    .command("add")
    .description("save a search")
    .argument("<name>")
    .argument("<query...>", "the query, as for `jobflow search`")
    .option("--no-source", "only use it as a feed view (don't poll sources with it)");
  addQueryOptions(add);
  add.action(async (name: string, words: string[], o: QueryOpts & { source?: boolean }) => {
    if (!name.trim()) throw usage("Give the search a name.");
    const query = buildQuery(words, o);
    const repo = await ctx.repo();
    const existing = await findSearch(repo, ctx.tenantId, name);
    const saved = await saveSearch(repo, ctx.tenantId, { id: existing?.id, name, query, asSource: o.source !== false });
    ctx.out.emit(saved, () => {
      ctx.out.ok(`${existing ? "Updated" : "Saved"} "${saved.name}": ${describeQuery(saved.query)}`);
      ctx.out.hint(`run it now: jobflow searches run ${JSON.stringify(saved.name)} · view: jobflow feed --search ${JSON.stringify(saved.name)}`);
    });
  });

  s.command("rm")
    .alias("remove")
    .description("delete a saved search")
    .argument("<name>")
    .action(async (name: string) => {
      const repo = await ctx.repo();
      const found = await findSearch(repo, ctx.tenantId, name);
      if (!found) throw notFound(`No saved search "${name}".`, "See them with `jobflow searches`.");
      await deleteSearch(repo, ctx.tenantId, found.id);
      ctx.out.emit({ ok: true, removed: found.name }, () => ctx.out.ok(`Removed "${found.name}"`));
    });

  s.command("run")
    .description("run a saved search now: fetch from its sources into your corpus, then re-rank")
    .argument("<name>")
    .action(async (name: string) => {
      const repo = await ctx.repo();
      const found = await findSearch(repo, ctx.tenantId, name);
      if (!found) throw notFound(`No saved search "${name}".`, "See them with `jobflow searches`.");
      const spin = ctx.out.spinner(`Running "${found.name}"`);
      const r = await runSearchNow(repo, ctx.tenantId, found.id).finally(() => spin.stop());
      ctx.out.emit({ name: found.name, ...r }, () => {
        ctx.out.ok(`"${found.name}": ${r.fetched} fetched, ${r.upserted} saved to your corpus`);
        const by = Object.entries(r.bySource).filter(([, n]) => n > 0);
        if (by.length) ctx.out.hint(by.map(([k, n]) => `${k} ${n}`).join(" · "));
        if (r.errors.length) ctx.out.hint(`errors: ${r.errors.slice(0, 3).join("; ")}`);
        ctx.out.hint(`view: jobflow feed --search ${JSON.stringify(found.name)}`);
      });
    });
}
