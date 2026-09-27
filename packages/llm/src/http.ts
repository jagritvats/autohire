/**
 * Resilience helpers for LLM providers (§ Customize — visible progress + retries).
 * Mirrors the adapters' `httpJson` AbortController pattern. Only *transient* failures
 * retry; auth/validation errors fail fast with a user-facing message.
 */

/** Errors carry a short user-facing message + the raw detail for a <details> panel. */
export class ProviderError extends Error {
  readonly userMessage: string;
  readonly detail: string;
  readonly status?: number;
  /** honored by withRetry as the backoff delay when the server sent Retry-After. */
  retryAfterMs?: number;
  constructor(userMessage: string, detail: string, status?: number, retryAfterMs?: number) {
    super(userMessage);
    this.name = "ProviderError";
    this.userMessage = userMessage;
    this.detail = detail;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP statuses worth retrying (rate limit / transient upstream / overloaded). */
export const RETRYABLE = [408, 425, 429, 500, 502, 503, 504, 529];

/** Map a provider HTTP error to a friendly message + keep the raw body as detail. */
export function mapProviderError(status: number, body: string, name = "provider", retryAfterMs?: number): ProviderError {
  const detail = `${name} ${status}: ${body}`.slice(0, 2000);
  let msg: string;
  if (status === 401 || status === 403) msg = "Invalid API key — check Settings › Generation model.";
  else if (status === 404) msg = "Model or endpoint not found — check the model name / base URL in Settings.";
  else if (status === 429) msg = "Rate limited — retry in a moment.";
  else if (status === 529 || status === 503) msg = "The model is overloaded — retry shortly.";
  else if (status >= 500) msg = `${name} had a server error (${status}) — retry shortly.`;
  else msg = `${name} request failed (${status}).`;
  return new ProviderError(msg, detail, status, retryAfterMs);
}

/** The model stopped at its output limit (`requireComplete`). 422 → not retried: the
 *  same request would stop at the same place. */
export function truncatedOutputError(name: string, maxTokens: number | undefined): ProviderError {
  return new ProviderError(
    `${name} stopped at its output limit before finishing — regenerate, or pick a model with a larger output limit.`,
    `${name}: output hit max_tokens=${maxTokens ?? "default"}`,
    422,
  );
}

/** A fetch with an abort-based timeout that throws a typed ProviderError on expiry. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, name = "provider"): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new ProviderError(`${name} timed out after ${Math.round(timeoutMs / 1000)}s — retry, or try a faster model.`, `${name}: aborted after ${timeoutMs}ms`);
    }
    throw new ProviderError(`Could not reach ${name} — check your network / base URL.`, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  name?: string;
}

/**
 * Run `fn` with backoff on transient ProviderErrors. `fn` receives the 0-based attempt
 * index. Honors a `Retry-After` hint passed back via a thrown ProviderError.retryAfterMs.
 * Non-retryable ProviderErrors (401/404/…) and the final attempt rethrow immediately.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const pe = e instanceof ProviderError ? e : null;
      const retryable = pe ? pe.status === undefined || RETRYABLE.includes(pe.status) : false;
      if (!retryable || attempt === retries) throw e;
      const hinted = (pe as ProviderError & { retryAfterMs?: number })?.retryAfterMs;
      const wait = hinted ?? base * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into ms, if present. */
export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
  const when = Date.parse(h);
  return Number.isNaN(when) ? undefined : Math.max(0, Math.min(when - Date.now(), 30_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
