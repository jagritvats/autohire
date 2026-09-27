import type { ExecutionTier, RawPosting, SourceKind } from "@jobflow/core";
import type { Enrichment, EnrichmentInput, FetchTarget, SourceAdapter } from "../types.js";
import { buildNaukriApiUrl, buildNaukriSeoUrl, naukriApiHeaders, parseNaukriApiJson, parseNaukriHtml, type NaukriSearchOptions } from "./naukri.js";
import { buildLinkedInUrl, parseLinkedInJobs } from "./linkedin.js";
import {
  DARWINBOX_MAX_PAGES,
  DARWINBOX_PAGE_SIZE,
  darwinboxCareersUrl,
  darwinboxJobsApiUrl,
  darwinboxJobsBody,
  parseDarwinboxJobs,
  parseDarwinboxSlug,
} from "./darwinbox.js";
import { buildPeerlistUrl, parsePeerlistPage, peerlistRoleFor } from "./peerlist.js";
import { parseWellfoundPage } from "../india/wellfound.js";
import {
  buildAmbitionBoxUrl,
  buildGlassdoorFindUrl,
  buildGlassdoorOverviewUrl,
  parseAmbitionBox,
  parseGlassdoor,
  resolveGlassdoorEmployerId,
} from "./enrich.js";

/**
 * Tier-3 sources (§1, §7.1): Naukri, AmbitionBox, Glassdoor, LinkedIn, Peerlist, the
 * Darwinbox careers boards, and a local path for Wellfound. No free API, scrape-hostile
 * or bot-walled. These run EXCLUSIVELY on the local agent, through the user's OWN
 * authenticated browser session, polite-paced, flag-guarded OFF by default. The
 * cloud orchestrator never imports or runs these (they're absent from the cloud
 * registry on purpose, invariant #1).
 *
 * The page-scraping is provided by the local runner (an injected `localFetch` /
 * `localFetchJson` bound to a Playwright page in the user's session). These classes own
 * the URL construction + the guard + the pure HTML/JSON → RawPosting parsing; the
 * network + session live entirely on the agent, so server bundles never fetch anything.
 */

export class Tier3DisabledError extends Error {}

export interface Tier3Context {
  /** opt-in source list from JOBFLOW_TIER3_SOURCES (csv) */
  enabledSources: string[];
  /** fetch+parse a page in the user's local session (rendered HTML); injected by the
   *  local agent. Absent server-side → adapter refuses to run. */
  localFetch?: (url: string) => Promise<string>;
  /** replay a site's own JSON/XHR endpoint from inside a first-party page (session
   *  cookies + custom headers). Enables Naukri's jobapi + Glassdoor id resolution, and
   *  (with `init`) the POST listing calls SPAs like Darwinbox make. */
  localFetchJson?: (url: string, headers?: Record<string, string>, init?: LocalFetchInit) => Promise<string>;
}

/** Extra request shape for `localFetchJson` — defaults to a GET after landing on the origin. */
export interface LocalFetchInit {
  method?: "GET" | "POST";
  body?: string;
  /** first-party page to land on before replaying (default: the URL's origin) — the
   *  careers SPA itself, so the request carries the same context the site's own does. */
  landingUrl?: string;
}

abstract class LocalTier3Adapter implements SourceAdapter {
  abstract readonly source: SourceKind;
  readonly tier: ExecutionTier = "tier3";
  constructor(protected ctx: Tier3Context) {}

  protected assertEnabled(): void {
    if (!this.ctx.localFetch) {
      throw new Tier3DisabledError(
        `${this.source} is Tier 3 — runs only on the local agent with your session. No localFetch injected.`,
      );
    }
    if (!this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(
        `${this.source} not in JOBFLOW_TIER3_SOURCES. Opt in per source (default off).`,
      );
    }
  }

  abstract fetch(target: FetchTarget): Promise<RawPosting[]>;
}

/** Naukri: India's largest board — the primary good-paying-SWE-in-India source. Bonus:
 *  each jobapi card carries the AmbitionBox rating, so a single pass yields jobs +
 *  ratings (§11.5). Prefers the internal JSON API; falls back to the rendered SRP DOM. */
export class NaukriAdapter extends LocalTier3Adapter {
  readonly source = "naukri" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const opts: NaukriSearchOptions = {
      query: target.query ?? "software engineer",
      location: target.location ?? "",
      minLpa: numParam(target, "minLpa"),
      freshnessDays: numParam(target, "freshnessDays"),
      experienceYears: numParam(target, "experienceYears"),
    };
    const limit = target.limit ?? 25;
    // best path: replay the SRP's own JSON (needs appid/systemid headers → localFetchJson)
    if (this.ctx.localFetchJson) {
      const body = await this.ctx.localFetchJson(
        buildNaukriApiUrl({ ...opts, pageSize: Math.max(limit, 20) }),
        naukriApiHeaders(),
      );
      const jobs = parseNaukriApiJson(body, limit);
      if (jobs.length) return jobs;
    }
    // fallback: parse the rendered search-results DOM
    const html = await this.ctx.localFetch!(buildNaukriSeoUrl(opts));
    return parseNaukriHtml(html, limit);
  }
}

/** LinkedIn: fetched via the static guest job-search fragment (the auth Voyager list is
 *  virtualized), through the user's session. India geo + experience-level facet. */
export class LinkedInAdapter extends LocalTier3Adapter {
  readonly source = "linkedin" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const url = buildLinkedInUrl({
      query: target.query ?? "software engineer",
      location: target.location ?? "",
      freshnessDays: numParam(target, "freshnessDays"),
      experienceYears: numParam(target, "experienceYears"),
    });
    const html = await this.ctx.localFetch!(url);
    return parseLinkedInJobs(html, target.limit ?? 25);
  }
}

/**
 * Darwinbox careers boards (Porter, Upstox…) — a board ATS with no cloud adapter
 * (Cloudflare rejects non-browser clients). The agent's `local_board_poll` hands this to
 * `ingestCompany` as its adapter, so the full-board staleness diff is shared (§3).
 * `slug` is the tenant subdomain. All-or-nothing: any page that fails to parse → [],
 * which ingest treats as "no data" (never mass-stales on a partial board).
 */
export class DarwinboxAdapter extends LocalTier3Adapter {
  readonly source = "darwinbox" as const;
  constructor(ctx: Tier3Context, private readonly opts: { companyName?: string } = {}) {
    super(ctx);
  }
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const board = parseDarwinboxSlug(target.slug);
    if (!board || !this.ctx.localFetchJson) return []; // the listing is a POST → needs the JSON replay
    const name = this.opts.companyName ?? board.host.split(".")[0]!;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" };
    const out = new Map<string, RawPosting>();
    for (let page = 1; page <= DARWINBOX_MAX_PAGES; page++) {
      const body = await this.ctx.localFetchJson(darwinboxJobsApiUrl(board), headers, {
        method: "POST",
        body: darwinboxJobsBody(board, page),
        landingUrl: darwinboxCareersUrl(board),
      });
      const parsed = parseDarwinboxJobs(body, board, name);
      if (!parsed) return []; // bot page / error → no data rather than a partial board
      for (const r of parsed.postings) out.set(r.atsJobId, r);
      const complete = parsed.pageLength < DARWINBOX_PAGE_SIZE || (parsed.total != null && out.size >= parsed.total);
      if (complete) return [...out.values()];
      await pause(2500, 4500); // human pacing between listing pages
    }
    return []; // bigger than the page cap: a truncated board must not drive markStale
  }
}

/**
 * Peerlist jobs — a discovery feed (company names + roles), read from its server-rendered
 * pages in the user's browser (Cloudflare challenges plain clients). `query` picks a
 * role family (/jobs/role/{role}); unmapped/absent → all roles. A couple of pages per
 * run: they're newest-first, and a poll every few hours only needs the head.
 */
export class PeerlistAdapter extends LocalTier3Adapter {
  readonly source = "peerlist" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const role = peerlistRoleFor(target.query);
    const maxPages = Math.min(Math.max(numParam(target, "maxPages") ?? 2, 1), 4);
    const limit = target.limit ?? 100;
    const out = new Map<string, RawPosting>();
    let page: number | null = 1;
    for (let i = 0; i < maxPages && page != null; i++) {
      if (i > 0) await pause(3000, 6000); // a burst drew a Cloudflare challenge — space them out
      const parsed = parsePeerlistPage(await this.ctx.localFetch!(buildPeerlistUrl({ role, page })));
      if (!parsed) break; // challenge / layout change → keep what we have (a feed, not a board)
      for (const r of parsed.postings) out.set(r.atsJobId, r);
      if (out.size >= limit) break;
      page = parsed.nextPage;
    }
    return [...out.values()].slice(0, limit);
  }
}

/**
 * Wellfound through the user's browser. The cloud `WellfoundAdapter` (tier 2) works from
 * a home connection but can be challenged from datacenter IPs; this local path reuses
 * the same page parser, so a posting keeps its id (`wellfound:<id>`) whichever plane
 * fetched it and the two never duplicate. `query` is a Wellfound role slug (mapped from
 * free text), `params.location` a location slug (default "india").
 */
export class WellfoundLocalAdapter extends LocalTier3Adapter {
  readonly source = "wellfound" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const role = wellfoundRoleFor(target.query);
    const where = String(target.params?.location ?? "india").toLowerCase().replace(/[^a-z0-9-]/g, "") || "india";
    const maxPages = Math.min(Math.max(numParam(target, "maxPages") ?? 2, 1), 5);
    const limit = target.limit ?? 150;
    const out = new Map<string, RawPosting>();
    let pageCount = maxPages;
    for (let page = 1; page <= Math.min(maxPages, pageCount); page++) {
      if (page > 1) await pause(3000, 5000);
      const parsed = parseWellfoundPage(await this.ctx.localFetch!(`https://wellfound.com/role/l/${role}/${where}?page=${page}`));
      if (!parsed) break;
      pageCount = parsed.pageCount ?? pageCount;
      for (const r of parsed.postings) out.set(r.atsJobId, { ...r, tier: "tier3" }); // fetched on the local plane
      if (out.size >= limit) break;
    }
    return [...out.values()].slice(0, limit);
  }
}

/** Wellfound role slugs seen on its /role/l/{role}/{location} pages; free text maps onto them. */
export function wellfoundRoleFor(query: string | null | undefined): string {
  const q = (query ?? "").trim().toLowerCase();
  const slug = q.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const known = ["software-engineer", "backend-engineer", "full-stack-engineer", "frontend-engineer", "devops-engineer", "data-engineer", "machine-learning-engineer", "mobile-engineer"];
  if (known.includes(slug)) return slug;
  if (/full[\s-]?stack/.test(q)) return "full-stack-engineer";
  if (/back[\s-]?end|java|golang|node|python|platform/.test(q)) return "backend-engineer";
  if (/front[\s-]?end|react/.test(q)) return "frontend-engineer";
  if (/devops|\bsre\b|site reliability/.test(q)) return "devops-engineer";
  if (/data eng/.test(q)) return "data-engineer";
  if (/\bml\b|machine learning/.test(q)) return "machine-learning-engineer";
  if (/android|\bios\b|mobile/.test(q)) return "mobile-engineer";
  return "software-engineer";
}

function pause(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

/** AmbitionBox / Glassdoor are enrichment sources (ratings + India comp), not job spines. */
abstract class LocalTier3Enricher {
  readonly tier: ExecutionTier = "tier3";
  abstract readonly source: SourceKind;
  constructor(protected ctx: Tier3Context) {}
  protected assertEnabled(): void {
    if (!this.ctx.localFetch || !this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(`${this.source} disabled / not local.`);
    }
  }
  abstract enrich(input: EnrichmentInput): Promise<Enrichment | null>;
}

/** AmbitionBox (Naukri-owned, no login, SSR __NEXT_DATA__) — the primary ratings + India
 *  comp source. Slug is derived from the name; the site 301s to the canonical page. */
export class AmbitionBoxEnricher extends LocalTier3Enricher {
  readonly source = "ambitionbox" as const;
  async enrich(input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    const html = await this.ctx.localFetch!(buildAmbitionBoxUrl(input.companyName));
    return parseAmbitionBox(html);
  }
}

/** Glassdoor — best-effort (aggressive anti-bot). Needs `localFetchJson` to resolve the
 *  numeric employer id from the name; then parses the Overview page's Apollo cache. */
export class GlassdoorEnricher extends LocalTier3Enricher {
  readonly source = "glassdoor" as const;
  async enrich(input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    if (!this.ctx.localFetchJson) return null; // id resolution needs a headered JSON fetch
    const findJson = await this.ctx.localFetchJson(buildGlassdoorFindUrl(input.companyName), { Accept: "application/json" });
    const employerId = resolveGlassdoorEmployerId(findJson, input.companyName);
    if (!employerId) return null;
    const html = await this.ctx.localFetch!(buildGlassdoorOverviewUrl(input.companyName, employerId));
    return parseGlassdoor(html);
  }
}

/** Read a numeric free-form FetchTarget param (minLpa / freshnessDays). */
function numParam(target: FetchTarget, key: string): number | undefined {
  const v = target.params?.[key];
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
