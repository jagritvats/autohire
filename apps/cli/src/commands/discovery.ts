import type { Command } from "commander";
import { JsonFeedMapping, type DiscoverySource } from "@jobflow/core";
import { parseCsv } from "@jobflow/pipeline";
import {
  addCompany,
  addSource,
  listDiscovery,
  removeDiscoverySource,
  setPresetFeed,
  setPresets,
  togglePreset,
  setSourceEnabledById,
} from "@jobflow/service";
import type { Ctx } from "../context.js";
import { CliError, EXIT, notFound, usage } from "../errors.js";
import { presetIds, readUserFile } from "./shared.js";

/**
 * What `jobflow sync` polls: the built-in presets you switch on (`listPresets()`: india,
 * global-remote, us, eu-uk, canada — several at once) PLUS your own sources. A preset is also a TAG: `jobflow search
 * … --preset us` and `jobflow feed --preset india` filter by it. Everything stays Tier 1–2 public data (invariant #1); every URL you add
 * passes the SSRF guard before it's saved.
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("sources")
    .description("what `jobflow sync` polls (same as `discovery list`)")
    .action(() => listAll(ctx));

  const d = program.command("discovery").description("switch presets on/off and add your own sources (RSS, JSON feeds, Telegram, HN, companies)");

  d.command("list", { isDefault: true }).description("your presets + custom sources").action(() => listAll(ctx));

  d.command("presets")
    .description("the built-in presets, with which are on")
    .action(async () => {
      const { presets } = await listDiscovery(await ctx.repo(), ctx.tenantId);
      ctx.out.emit(presets, () => {
        for (const p of presets) {
          ctx.out.line(`${p.active ? ctx.out.green("on ") : ctx.out.dim("off")} ${ctx.out.bold(p.id.padEnd(14))} ${p.label} ${ctx.out.dim(`· markets ${p.markets.join(",") || "any"} · ${p.feeds.length} feeds · ${p.companies} companies`)}`);
          ctx.out.line(`    ${" ".repeat(14)} ${ctx.out.dim(p.description)}`);
        }
        ctx.out.hint("choose: jobflow discovery use india,global-remote · or: jobflow discovery preset-on us / preset-off india");
      });
    });

  d.command("use")
    .description("switch on exactly these presets (one or several), e.g. india,global-remote")
    .argument("<presets...>")
    .action(async (words: string[]) => {
      const on = await setPresets(await ctx.repo(), ctx.tenantId, presetIds(words));
      ctx.out.emit({ ok: true, presets: on }, () => ctx.out.ok(`Discovery presets: ${on.join(", ")}. Run \`jobflow sync\` to poll them.`));
    });

  for (const [name, on] of [
    ["preset-on", true],
    ["preset-off", false],
  ] as const) {
    d.command(name)
      .description(`switch one preset ${on ? "on" : "off"}, keeping the others`)
      .argument("<preset>")
      .action(async (id: string) => {
        const [preset] = presetIds(id);
        if (!preset) throw usage("name a preset");
        const now = await togglePreset(await ctx.repo(), ctx.tenantId, preset, on).catch((e: Error) => {
          throw usage(e.message);
        });
        ctx.out.emit({ ok: true, presets: now }, () => ctx.out.ok(`Discovery presets: ${now.join(", ")}`));
      });
  }

  d.command("add-rss")
    .description("add an RSS/Atom job feed")
    .argument("<url>")
    .option("--company <name>", "the employer, if the feed is one company's")
    .option("--label <label>")
    .action(async (url: string, o: { company?: string; label?: string }) => {
      await added(ctx, await addSource(await ctx.repo(), ctx.tenantId, { label: o.label, config: { kind: "rss", url, company: o.company ?? null } }));
    });

  d.command("add-json")
    .description("add a JSON job feed (jsonfeed.org shape by default; --map for others)")
    .argument("<url>")
    .option("--map <file.json>", "field mapping: {itemsPath, id, title, company, url, location, description, postedAt, salary}")
    .option("--label <label>")
    .action(async (url: string, o: { map?: string; label?: string }) => {
      let mapping = {};
      if (o.map) {
        const f = await readUserFile(ctx, o.map);
        try {
          mapping = JsonFeedMapping.parse(JSON.parse(Buffer.from(f.bytes).toString("utf8")));
        } catch (e) {
          throw usage(`--map ${o.map}: ${(e as Error).message}`);
        }
      }
      await added(ctx, await addSource(await ctx.repo(), ctx.tenantId, { label: o.label, config: { kind: "json_feed", url, mapping } }));
    });

  d.command("add-telegram")
    .description("add a public Telegram channel (its ATS/careers links are harvested)")
    .argument("<channel>", "channel name or t.me link")
    .action(async (channel: string) => {
      const c = channel.replace(/^(https?:\/\/)?(t\.me\/)(s\/)?/i, "").replace(/^@/, "").replace(/\/.*$/, "");
      await added(ctx, await addSource(await ctx.repo(), ctx.tenantId, { config: { kind: "telegram", channel: c } }));
    });

  d.command("add-hn")
    .description("add a Hacker News 'Who is hiring' thread (default: the latest each month)")
    .argument("[storyId]")
    .action(async (storyId?: string) => {
      const id = storyId?.match(/(\d+)/)?.[1] ?? null;
      await added(ctx, await addSource(await ctx.repo(), ctx.tenantId, { config: { kind: "hn_thread", storyId: id } }));
    });

  d.command("add-company")
    .description("follow one company: a careers URL (its ATS is detected) or a name")
    .argument("<urlOrName...>")
    .action(async (words: string[]) => {
      const v = words.join(" ").trim();
      const isUrl = /^https?:\/\//i.test(v);
      const spin = ctx.out.spinner(`Detecting the job board for ${v}`);
      const r = await addCompany(await ctx.repo(), ctx.tenantId, isUrl ? { careersUrl: v } : { name: v }).finally(() => spin.stop());
      ctx.out.emit(r, () => {
        if (r.company && r.resolved) ctx.out.ok(`Following ${r.company.name} (${r.company.atsType}${r.company.atsSlug ? `: ${r.company.atsSlug}` : ""}) — polled on the next sync.`);
        else if (r.company) ctx.out.line(`Following ${r.company.name}, but its job board wasn't detected yet${isUrl ? "" : " — try its careers page URL"}.`);
        else ctx.out.line("Couldn't add that company.");
      });
    });

  d.command("import-companies")
    .description("follow a list of companies from a CSV (columns: name, careers_url) or one name/URL per line")
    .argument("<file>")
    .option("--label <label>")
    .action(async (file: string, o: { label?: string }) => {
      const f = await readUserFile(ctx, file);
      const companies = companiesFromText(Buffer.from(f.bytes).toString("utf8"));
      if (!companies.length) throw usage(`No companies found in ${file}.`, "Use a CSV with a name (and optionally careers_url) column, or one name/URL per line.");
      const spin = ctx.out.spinner(`Adding ${companies.length} companies (detecting their job boards)`);
      const s = await addSource(await ctx.repo(), ctx.tenantId, { label: o.label, config: { kind: "company_list", companies } }).finally(() => spin.stop());
      await added(ctx, s);
    });

  for (const [name, on] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    d.command(name)
      .description(`${name} a custom source (id / prefix / number in \`discovery list\`) or a preset feed (its id)`)
      .argument("<id>")
      .action(async (id: string) => {
        const repo = await ctx.repo();
        const view = await listDiscovery(repo, ctx.tenantId);
        const feed = view.presets.filter((p) => p.active).flatMap((p) => p.feeds).find((f) => f.id === id);
        if (feed) {
          await setPresetFeed(repo, ctx.tenantId, feed.id, on);
          ctx.out.emit({ ok: true, feed: feed.id, enabled: on }, () => ctx.out.ok(`${on ? "Enabled" : "Disabled"} preset feed ${feed.id}`));
          return;
        }
        const s = pickSource(view.sources, id);
        await setSourceEnabledById(repo, ctx.tenantId, s.id, on);
        ctx.out.emit({ ok: true, source: s.id, enabled: on }, () => ctx.out.ok(`${on ? "Enabled" : "Disabled"} ${s.label}`));
      });
  }

  d.command("rm")
    .alias("remove")
    .description("remove a custom source")
    .argument("<id>")
    .action(async (id: string) => {
      const repo = await ctx.repo();
      const s = pickSource((await listDiscovery(repo, ctx.tenantId)).sources, id);
      await removeDiscoverySource(repo, ctx.tenantId, s.id);
      ctx.out.emit({ ok: true, removed: s.id }, () => ctx.out.ok(`Removed ${s.label}`));
    });
}

async function listAll(ctx: Ctx): Promise<void> {
  const v = await listDiscovery(await ctx.repo(), ctx.tenantId);
  const active = v.presets.filter((p) => p.active);
  ctx.out.emit(v, () => {
    const out = ctx.out;
    out.line(`${out.bold("Presets on")}  ${active.map((p) => p.id).join(", ") || "(none)"} ${out.dim(`· ${active.reduce((n, p) => n + p.companies, 0)} seed companies · all presets: jobflow discovery presets`)}`);
    const seen = new Set<string>();
    for (const p of active)
      for (const f of p.feeds) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        out.line(`  ${f.enabled ? out.green("on ") : out.dim("off")} ${f.id} ${out.dim(`(${f.source} · ${p.id})`)}`);
      }
    out.line();
    out.line(out.bold("Your sources"));
    if (!v.sources.length) out.line(out.dim("  none — add with: jobflow discovery add-rss|add-json|add-telegram|add-hn|add-company|import-companies"));
    v.sources.forEach((s, i) => {
      const last = s.lastRunAt ? `${s.lastStatus ?? "?"} · ${s.lastCount ?? 0} last run` : "not run yet";
      out.line(`  ${out.dim(`${String(i + 1).padStart(2)}.`)} ${s.enabled ? out.green("on ") : out.dim("off")} ${s.label} ${out.dim(`· ${s.config.kind} · ${last} · ${s.id.slice(0, 8)}`)}`);
      if (s.lastError) out.line(`        ${out.yellow(s.lastError)}`);
    });
    if (v.followed.length) out.line(out.dim(`\nFollowing ${v.followed.length} compan${v.followed.length === 1 ? "y" : "ies"}.`));
  });
}

async function added(ctx: Ctx, s: DiscoverySource): Promise<void> {
  ctx.out.emit(s, () => {
    ctx.out.ok(`Added ${s.label} (${s.config.kind}, ${s.id.slice(0, 8)})`);
    ctx.out.hint("It's polled on the next `jobflow sync`.");
  });
}

function pickSource(sources: DiscoverySource[], ref: string): DiscoverySource {
  const r = ref.trim().replace(/^#/, "");
  if (/^\d{1,3}$/.test(r)) {
    const s = sources[Number(r) - 1];
    if (!s) throw notFound(`There's no source #${r}.`);
    return s;
  }
  const hits = sources.filter((s) => s.id.startsWith(r.toLowerCase()));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw notFound(`No source or preset feed "${ref}".`, "See them with `jobflow discovery list`.");
  throw new CliError(`"${ref}" matches ${hits.length} sources — use more characters.`, EXIT.usage);
}

/** CSV with a name/company column (+ careers_url/url/website), or one name or URL per line */
export function companiesFromText(text: string): Array<{ name: string; careersUrl: string | null }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0]!.toLowerCase();
  if (/(^|,)\s*"?(name|company)"?\s*(,|$)/.test(header)) {
    const rows = parseCsv(text);
    return rows
      .map((r) => {
        const get = (...ks: string[]) => {
          for (const [k, v] of Object.entries(r)) if (ks.includes(k.trim().toLowerCase().replace(/[\s-]/g, "_"))) return v?.trim() ?? "";
          return "";
        };
        const name = get("name", "company", "company_name");
        const url = get("careers_url", "careersurl", "url", "website", "careers");
        return { name: name || (url ? safeHost(url) : ""), careersUrl: url || null };
      })
      .filter((c) => c.name)
      .slice(0, 500);
  }
  return lines
    .map((l) => l.replace(/^"|"$/g, ""))
    .map((l) => (/^https?:\/\//i.test(l) ? { name: safeHost(l), careersUrl: l } : { name: l, careersUrl: null }))
    .filter((c) => c.name)
    .slice(0, 500);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(www|jobs|careers|boards)\./, "");
  } catch {
    return "";
  }
}

