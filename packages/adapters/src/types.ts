import type { ExecutionTier, RawPosting, SourceKind } from "@jobflow/core";

/**
 * The one interface every source implements (§ Source Adapters). The orchestrator
 * routes purely by `tier`: tier1-2 run in cloud cron, tier3 only on the local agent.
 * Adding a source later = one new adapter, zero pipeline change.
 */
export interface SourceAdapter {
  readonly source: SourceKind;
  readonly tier: ExecutionTier;
  /**
   * Fetch raw postings. For ATS adapters `target` is the board slug; for
   * aggregators it's a search query / params object. Adapters MUST be polite and
   * resilient — return [] on a recoverable error rather than throwing the pipeline.
   */
  fetch(target: FetchTarget): Promise<RawPosting[]>;
  /**
   * Optional per-job liveness probe for the dead-link check (§3): `true` = still listed,
   * `false` = the source DEFINITIVELY says it's gone (a per-job 404/410, or the board's own
   * closed/expired flag), `null` = couldn't tell (network error, rate limit, 5xx, a page
   * that renders the same either way). A posting is only ever retired on `false`.
   */
  isLive?(job: LivenessTarget): Promise<boolean | null>;
}

export interface LivenessTarget {
  /** the company's board slug (ATS boards), null for feed sources */
  slug: string | null;
  /** the source's own job id (unscoped — no "source:" prefix) */
  jobId: string;
  applyUrl: string | null;
}

/**
 * Status of a GET without following redirects — for liveness probes, where a 404 is the
 * answer rather than a failure. null on a network error or timeout (unknown, not gone).
 */
export async function httpStatus(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string } | null> {
  const { timeoutMs = 15_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      ...rest,
      signal: ctrl.signal,
      headers: {
        "User-Agent": "JobFlow/0.1 (+personal job-search; contact via app)",
        Accept: "application/json",
        ...(rest.headers ?? {}),
      },
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 404/410 = gone; 2xx/3xx = there; anything else (403/429/5xx) = can't tell. */
export function liveFromStatus(r: { status: number } | null): boolean | null {
  if (!r) return null;
  if (r.status === 404 || r.status === 410) return false;
  if (r.status >= 200 && r.status < 400) return true;
  return null;
}

export interface FetchTarget {
  slug?: string;
  query?: string;
  location?: string;
  /** free-form per-adapter params */
  params?: Record<string, string | number | boolean>;
  /** max results to pull this run (politeness / cost) */
  limit?: number;
  /**
   * Job ids already stored with full detail. Boards that need a per-posting detail call
   * for the JD (SmartRecruiters, Workday, Eightfold) return a LITE posting (no jdText)
   * for these instead of re-fetching — ingest then just re-confirms them as seen.
   */
  known?: ReadonlySet<string>;
}

/** Max per-board detail calls per poll for NEW postings (politeness; the rest next poll). */
export const DETAIL_CAP = 60;

const ENG_TITLE = /\b(engineer\w*|engr|developer|sde|swe|programmer|backend|back-end|front-?end|full[- ]?stack|devops|sre|site reliability|platform|data engineer|software|architect|qa|sdet|test automation)\b/i;
const NON_ENG_TITLE = /\b(sales|account (executive|manager)|marketing|recruit\w*|talent acquisition|hr\b|human resources|finance|accountant|legal|counsel|customer (success|service|support)|business development|operations (associate|analyst|manager)|nurse|pharmac\w*|clinical|driver|warehouse|store|retail|mechanical|civil|electrical|chemical|facility|facilities)\b/i;

/**
 * Pick which NEW postings get a (costly) detail call: engineering-looking titles first,
 * clearly non-engineering ones never — they rank low on the title alone (archetype), so
 * their JD adds nothing. Large employers list hundreds of India roles, mostly not
 * engineering (Citi: ~960 India, ~250 engineering); this keeps the detail budget on
 * roles that can actually match.
 */
export function pickForDetail<T>(items: T[], title: (t: T) => string, cap: number): T[] {
  const eng = items.filter((i) => ENG_TITLE.test(title(i)) && !NON_ENG_TITLE.test(title(i)));
  const other = items.filter((i) => !ENG_TITLE.test(title(i)) && !NON_ENG_TITLE.test(title(i)));
  return [...eng, ...other].slice(0, cap);
}

/** Run `fn` over `items` with at most `n` in flight (polite detail fetching). */
export async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** ISO-3166 alpha-2 → the country NAME boards use in facets / location strings. */
export const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  SG: "Singapore",
  AE: "United Arab Emirates",
  CA: "Canada",
};

/** Enrichment adapters return structured enrichment keyed to a company/posting. */
export interface EnrichmentAdapter {
  readonly source: SourceKind;
  readonly tier: ExecutionTier;
  enrich(input: EnrichmentInput): Promise<Enrichment | null>;
}

export interface EnrichmentInput {
  companyName: string;
  companySlug?: string;
  roleArchetype?: string;
  location?: string;
}

export interface Enrichment {
  source: SourceKind;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  ratingOverall?: number;
  ratingWlb?: number;
  ratingComp?: number;
  reviewCount?: number;
  cultureSummary?: string;
  interviewDifficulty?: string;
}

/** Small fetch helper with timeout + a polite UA. Used by every cloud adapter. */
export async function httpJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T | null> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        "User-Agent": "JobFlow/0.1 (+personal job-search; contact via app)",
        Accept: "application/json",
        ...(rest.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Text twin of httpJson (careers-page HTML, XML feeds); null on any failure. */
export async function httpText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<string | null> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers: { "User-Agent": "JobFlow/0.1 (+personal job-search; contact via app)", ...(rest.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the handful of HTML entities feeds use to escape embedded markup. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Strip HTML to readable text for JD parsing (ATS JDs come as HTML). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
