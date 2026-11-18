import { activeFx, installFxRates, isValidFxTable, type FxTable } from "@jobflow/core";
import { httpJson } from "@jobflow/adapters";

/**
 * FX rates, pipeline side (§11.4). Core ships a dated static table and never needs the
 * network; this optionally refreshes it from a free, keyless public source — the ECB's
 * euro reference rates via frankfurter (api.frankfurter.dev, rebased to USD) — and caches
 * the result in the store (`store_meta.fx_rates`, JSON with its own date), so every process
 * on the same store converts at the same, dated rate.
 *
 * Never required: an unreachable API, a bad payload or a read-only store just leaves the
 * newest table we have in place. The ECB publishes once per working day, so a cached
 * table younger than `FX_REFRESH_HOURS` isn't re-fetched.
 */

export const FX_META_KEY = "fx_rates";
export const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
const FX_REFRESH_HOURS = 20;

interface CachedFx extends FxTable {
  /** when we fetched it (ISO) — the rates' own date is `asOf` */
  fetchedAt: string;
}

export interface FxStore {
  getStoreMeta(key: string): Promise<string | null>;
  setStoreMeta(key: string, value: string): Promise<void>;
}

/** frankfurter's payload → an FxTable; null if it isn't one */
export function parseFrankfurter(body: unknown): FxTable | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { base?: unknown; date?: unknown; rates?: unknown };
  if (b.base !== "USD" || typeof b.date !== "string" || !b.rates || typeof b.rates !== "object") return null;
  const perUsd: Record<string, number> = { USD: 1 };
  for (const [k, v] of Object.entries(b.rates as Record<string, unknown>)) if (typeof v === "number") perUsd[k.toUpperCase()] = v;
  const t: FxTable = { asOf: b.date, source: "ECB reference rates via frankfurter", perUsd };
  return isValidFxTable(t) ? t : null;
}

async function readCached(store: FxStore): Promise<CachedFx | null> {
  try {
    const raw = await store.getStoreMeta(FX_META_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as CachedFx;
    return t && isValidFxTable(t) ? t : null;
  } catch {
    return null;
  }
}

/** Install the store's cached table, if it is newer than what this process has. No network. */
export async function loadFxRates(store: FxStore): Promise<FxTable> {
  const cached = await readCached(store);
  return installFxRates(cached);
}

export interface FxRefreshResult {
  /** the table now in use */
  table: FxTable;
  /** "fetched" a new table, "cached" (fresh enough, or the fetch failed), or "static" */
  status: "fetched" | "cached" | "static";
}

/**
 * Refresh the cached table when it is older than a day, then install the newest one. The
 * fetch is injectable (tests); any failure keeps what we have.
 */
export async function refreshFxRates(
  store: FxStore,
  opts: { now?: Date; fetchJson?: (url: string) => Promise<unknown>; force?: boolean } = {},
): Promise<FxRefreshResult> {
  const now = opts.now ?? new Date();
  const cached = await readCached(store);
  if (cached) installFxRates(cached);
  const fresh = cached && now.getTime() - Date.parse(cached.fetchedAt) < FX_REFRESH_HOURS * 3_600_000;
  if (fresh && !opts.force) return { table: activeFx(), status: "cached" };

  const fetchJson = opts.fetchJson ?? ((url: string) => httpJson(url, { timeoutMs: 8_000 }));
  let table: FxTable | null = null;
  try {
    table = parseFrankfurter(await fetchJson(FX_URL));
  } catch {
    table = null;
  }
  if (!table) return { table: activeFx(), status: cached ? "cached" : "static" };
  try {
    const row: CachedFx = { ...table, fetchedAt: now.toISOString() };
    await store.setStoreMeta(FX_META_KEY, JSON.stringify(row));
  } catch {
    // a store we can't write still converts at the fetched rate in this process
  }
  installFxRates(table);
  return { table: activeFx(), status: "fetched" };
}

/** whether a sync should try the network for rates (`JOBFLOW_FX_REFRESH=0` turns it off; tests never do) */
export function fxRefreshEnabled(): boolean {
  return process.env.JOBFLOW_FX_REFRESH !== "0" && !process.env.VITEST;
}
