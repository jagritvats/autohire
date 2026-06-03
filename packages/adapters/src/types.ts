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
}

export interface FetchTarget {
  slug?: string;
  query?: string;
  location?: string;
  /** free-form per-adapter params */
  params?: Record<string, string | number | boolean>;
  /** max results to pull this run (politeness / cost) */
  limit?: number;
}

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
