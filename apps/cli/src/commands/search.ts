import type { Command } from "commander";
import type { Posting, SearchQuery, SourceKind } from "@jobflow/core";
import { searchCapableAdapters } from "@jobflow/adapters";
import { isOnboarded, loadProfile, makeSearchQuery, presetFeedSources, type SearchFlags } from "@jobflow/pipeline";
import { saveSearch, searchJobs } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { usage } from "../errors.js";
import { printCards } from "../render/card.js";
import { collect, presetIds } from "./shared.js";

/**
 * `jobflow search "<query>" [flags]` — the headline command. Asks the search-capable
 * Tier 1–2 sources live (invariant #1: nothing session-bound), scores every result against
 * YOUR profile with the same honest scorer as the feed, and shows the query as a view:
 * what it hid is counted, never silently dropped, and no score is bent (invariant #4).
 */

export interface QueryOpts {
  remote?: boolean;
  onsite?: boolean;
  loc?: string[];
  country?: string[];
  seniority?: string[];
  minSalary?: string;
  currency?: string;
  posted?: string;
  sources?: string[];
  must?: string[];
  nice?: string[];
  title?: string[];
  excludeCompany?: string[];
  exclude?: string[];
  preset?: string[];
  tag?: string[];
}

/** the query flags shared by `search` and `searches add` */
export function addQueryOptions(cmd: Command): Command {
  return cmd
    .option("--remote", "remote roles only")
    .option("--onsite", "exclude remote roles")
    .option("--loc <place>", 'a place: "Berlin,DE", "US", "Bengaluru" (repeatable)', collect)
    .option("--country <CC>", "a country, ISO-2 (repeatable)", collect)
    .option("--seniority <levels>", "e.g. senior,staff (repeatable)", collect)
    .option("--min-salary <amount>", 'e.g. "150000 USD", "150k", "40L INR"')
    .option("--currency <code>", "currency for a bare --min-salary number")
    .option("--posted <age>", "posted within: 7d, 2w, 1m")
    .option("--sources <list>", "only these sources, e.g. remotive,himalayas (repeatable)", collect)
    .option("--must <skills>", "skills the role must mention (repeatable)", collect)
    .option("--nice <skills>", "skills that are a plus (repeatable)", collect)
    .option("--title <text>", "title must contain (repeatable)", collect)
    .option("--exclude-company <name>", "hide a company (repeatable)", collect)
    .option("--exclude <keyword>", "hide roles mentioning this (repeatable)", collect)
    .option("--preset <presets>", "only roles tagged with these discovery presets, e.g. us,eu-uk (searches their feeds)", collect)
    .option("--tag <presets>", "same as --preset", collect);
}

/** shell args → the query text makeSearchQuery parses (multi-word args stay one phrase) */
export function queryText(words: string[]): string {
  return words.map((w) => (/\s/.test(w) && !/^".*"$/.test(w) ? `"${w}"` : w)).join(" ");
}

export function buildQuery(words: string[], o: QueryOpts): SearchQuery {
  const flags: SearchFlags = {};
  if (o.remote) flags.remote = true;
  if (o.onsite) flags.remote = "exclude";
  if (o.loc?.length) flags.loc = o.loc.join(";");
  if (o.country?.length) flags.country = o.country;
  if (o.seniority?.length) flags.seniority = o.seniority;
  if (o.minSalary) flags.minSalary = o.minSalary;
  if (o.currency) flags.currency = o.currency;
  if (o.posted) flags.posted = o.posted;
  if (o.sources?.length) flags.sources = o.sources;
  if (o.must?.length) flags.must = o.must;
  if (o.nice?.length) flags.nice = o.nice;
  if (o.title?.length) flags.title = o.title;
  if (o.excludeCompany?.length) flags.excludeCompany = o.excludeCompany;
  if (o.exclude?.length) flags.exclude = o.exclude;
  const tags = [...(o.preset ?? []), ...(o.tag ?? [])];
  if (tags.length) flags.preset = presetIds(tags);
  const q = makeSearchQuery(queryText(words), flags);
  if (o.minSalary && !q.minSalary) throw usage(`couldn't read --min-salary "${o.minSalary}"`, 'Try "150000 USD", "150k USD" or "40L INR".');
  if (o.posted && !q.postedWithinDays) throw usage(`couldn't read --posted "${o.posted}"`, "Try 7d, 2w or 1m.");
  const unknownSources = (o.sources ?? []).flatMap((s) => s.split(",")).map((s) => s.trim().toLowerCase()).filter((s) => s && !q.sources.includes(s as SourceKind));
  if (unknownSources.length) throw usage(`unknown source(s): ${unknownSources.join(", ")}`, `Search-capable: ${searchCapableAdapters().map((a) => a.source).join(", ")}`);
  return q;
}

/** one-line description of a query ("backend engineer · remote · senior · ≥150k USD") */
export function describeQuery(q: SearchQuery): string {
  const parts: string[] = [];
  if (q.keywords.length) parts.push(q.keywords.map((k) => `“${k}”`).join(" "));
  if (q.titles.length) parts.push(`title: ${q.titles.join("/")}`);
  if (q.remote === "only") parts.push("remote");
  if (q.remote === "exclude") parts.push("on-site");
  if (q.locations.length) parts.push(q.locations.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join(" | "));
  if (q.seniority.length) parts.push(q.seniority.join("/"));
  if (q.minSalary) parts.push(`≥ ${q.minSalary.amount.toLocaleString("en")} ${q.minSalary.currency}`);
  if (q.postedWithinDays) parts.push(`≤ ${q.postedWithinDays}d old`);
  if (q.mustSkills.length) parts.push(`must: ${q.mustSkills.join(", ")}`);
  if (q.sources.length) parts.push(`sources: ${q.sources.join(", ")}`);
  if (q.presets.length) parts.push(q.presets.map((p) => `#${p}`).join(" "));
  return parts.join(" · ") || "(everything)";
}

export function register(program: Command, ctx: Ctx): void {
  const cmd = program
    .command("search")
    .description("search live job sources and rank the results against your profile")
    .argument("[query...]", 'what you\'re looking for, e.g. "backend engineer"')
    .option("-n, --limit <n>", "results to show", "15")
    .option("--sort <by>", "score (default) | relevance")
    .option("--format <fmt>", "cards (default) | table")
    .option("--ingest", "also add what was found to your corpus/feed")
    .option("--save-as <name>", "save this as a saved search (it then runs on every sync and works as a feed view)");
  addQueryOptions(cmd);
  cmd.addHelpText(
    "after",
    `
Examples:
  jobflow search "backend engineer" --remote
  jobflow search "staff platform" --loc "Berlin,DE" --seniority staff --min-salary "120000 EUR"
  jobflow search golang --must kafka --posted 7d --save-as go-kafka
  jobflow search "backend" --preset us,eu-uk      (only roles tagged #us / #eu-uk)
Then: jobflow show 1 · jobflow tailor 1 · jobflow apply 1`,
  );
  cmd.action(async (words: string[], o: QueryOpts & { limit: string; sort?: string; format?: string; ingest?: boolean; saveAs?: string }) => {
    const query = buildQuery(words, o);
    if (!query.keywords.length && !query.titles.length && !query.mustSkills.length && !query.presets.length) {
      throw usage("Say what to search for, e.g. jobflow search \"backend engineer\" --remote");
    }
    const limit = Math.max(1, Math.min(100, Number(o.limit) || 15));
    if (o.sort && o.sort !== "score" && o.sort !== "relevance") throw usage("--sort must be score or relevance");
    const repo = await ctx.repo();
    const profile = await loadProfile(repo, ctx.tenantId);
    const scored = isOnboarded(profile);
    const nSources = query.sources.length || (query.presets.length ? presetFeedSources(query.presets).filter((s) => searchCapableAdapters().some((a) => a.source === s)).length : searchCapableAdapters().length);
    const spin = ctx.out.spinner(`Searching ${nSources} live source${nSources === 1 ? "" : "s"} for ${describeQuery(query)}`);
    const started = Date.now();
    let r: Awaited<ReturnType<typeof searchJobs>>;
    try {
      r = await searchJobs(repo, ctx.tenantId, query, { ingest: !!o.ingest, limit, sort: o.sort as "score" | "relevance" | undefined, withPostings: true });
    } finally {
      spin.stop();
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    // remember the listing so `show 2` / `tailor 2` / `apply 2` work; results that aren't in
    // the corpus are kept (as transient) and saved into it only when you pick one
    const postings = r.postings ?? [];
    const ids: string[] = [];
    const transient: Record<string, Posting> = {};
    for (const [i, c] of r.cards.entries()) {
      const p = postings[i];
      if (!p) continue;
      if (c.inFeed) ids.push(c.id);
      else if (o.ingest) {
        const stored = (await repo.findPostingsByAtsIds(p.atsType, [p.atsJobId]))[0];
        ids.push(stored?.id ?? c.id);
        if (stored) c.id = stored.id;
      } else {
        ids.push(c.id);
        transient[c.id] = p;
      }
    }
    ctx.rememberListing("search", ids, transient);

    let saved: { id: string; name: string } | null = null;
    if (o.saveAs) {
      const s = await saveSearch(repo, ctx.tenantId, { name: o.saveAs, query });
      saved = { id: s.id, name: s.name };
    }

    const { postings: _p, ...rest } = r;
    ctx.out.emit({ ...rest, scored, saved, seconds: Number(secs) }, () => {
      const out = ctx.out;
      const sourcesHit = Object.entries(r.bySource).filter(([, n]) => n > 0);
      if (!r.cards.length) {
        if (r.fetched === 0) {
          out.line(`No results for ${describeQuery(query)}.`);
          out.hint(
            sourcesHit.length === 0
              ? `None of the ${r.sources.length} sources answered (${secs}s) — check your network with \`jobflow doctor\`, or try other words.`
              : "Nothing matched — try broader words or fewer flags.",
          );
        } else {
          out.line(`Found ${r.fetched} posting(s), but none passed: ${r.hiddenTotal} hidden by your query, ${r.excluded} hard-excluded.`);
        }
      } else {
        out.line(
          `${out.bold(String(r.cards.length))} result${r.cards.length === 1 ? "" : "s"} for ${describeQuery(query)} ${out.dim(
            `· ${r.fetched} fetched from ${sourcesHit.length}/${r.sources.length} sources in ${secs}s${scored ? " · ranked for you" : ""}`,
          )}`,
        );
        if (!scored) out.line(out.yellow("Unscored — set up your profile (`jobflow init`) to rank these against you."));
        out.line();
        printCards(out, r.cards, { scored, format: o.format });
      }
      const hidden = Object.entries(r.hidden).filter(([, n]) => n > 0);
      if (hidden.length) out.hint(`hidden by your query: ${r.hiddenTotal} (${hidden.map(([k, n]) => `${k} ${n}`).join(", ")}) — scores are never changed by a query`);
      if (r.excluded) out.hint(`${r.excluded} hard-excluded (stated pay below your floor, or a location you can't work from)`);
      if (r.errors.length) out.hint(`some sources failed: ${r.errors.slice(0, 3).join("; ")}`);
      if (o.ingest) out.hint(`added ${r.ingested ?? 0} posting(s) to your corpus — they're in \`jobflow feed\` now`);
      if (saved) out.ok(`saved as "${saved.name}" — runs on every \`jobflow sync\`; view with \`jobflow feed --search ${JSON.stringify(saved.name)}\``);
      if (r.cards.length) out.hint("next: jobflow show 1 · jobflow tailor 1 · jobflow apply 1");
    });
  });
}
