import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import {
  DiscoverySourceConfig,
  activePresets,
  canonicalConfigJson,
  normCompany,
  type DiscoverySource,
} from "@jobflow/core";
import { safeUrl } from "@jobflow/adapters";
import { discoverCompanies, getPreset, listPresets, type DiscoveryPreset } from "@jobflow/pipeline";
import { ensureTenant } from "./tenant.js";

/**
 * Configurable discovery (web + CLI): a built-in preset (today's discovery is the `india`
 * preset) PLUS your own sources — RSS/Atom feeds, JSON feeds, Telegram channels, HN
 * threads, company lists, single careers pages. Your source config is private; the public
 * postings it finds join the shared corpus. Everything stays Tier 1–2 (invariant #1), and
 * every user-supplied URL passes the SSRF guard before it's saved.
 */

export interface PresetView {
  id: string;
  label: string;
  description: string;
  markets: string[];
  active: boolean;
  feeds: Array<{ id: string; source: string; enabled: boolean }>;
  companies: number;
}

export async function listDiscovery(repo: Repository, tenantId: string): Promise<{ presets: PresetView[]; sources: DiscoverySource[]; followed: string[] }> {
  await ensureTenant(repo, tenantId);
  const config = await repo.getConfig(tenantId);
  const disabled = new Set(config?.presetFeedsDisabled ?? []);
  const on = new Set(activePresets(config));
  const presets = listPresets().map((p: DiscoveryPreset) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    markets: p.markets,
    active: on.has(p.id),
    feeds: p.feeds.map((f) => ({ id: f.id, source: f.source, enabled: !disabled.has(f.id) })),
    companies: p.seedCompanies.length,
  }));
  return { presets, sources: await repo.listDiscoverySources(tenantId), followed: await repo.listFollowedCompanyIds(tenantId) };
}

function checkPreset(id: string): void {
  if (!getPreset(id)) throw new Error(`Unknown preset "${id}". Try: ${listPresets().map((p) => p.id).join(", ")}`);
}

/** Switch on exactly these presets (multi-select). */
export async function setPresets(repo: Repository, tenantId: string, presetIds: string[]): Promise<string[]> {
  const ids = [...new Set(presetIds.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) throw new Error("Keep at least one preset on (add your own sources on top).");
  ids.forEach(checkPreset);
  await ensureTenant(repo, tenantId);
  const config = await repo.getConfig(tenantId);
  if (config) await repo.saveConfig({ ...config, discoveryPresets: ids, discoveryPreset: ids[0]! });
  return ids;
}

/** Turn one preset on or off, keeping the others. */
export async function togglePreset(repo: Repository, tenantId: string, presetId: string, enabled: boolean): Promise<string[]> {
  checkPreset(presetId);
  await ensureTenant(repo, tenantId);
  const current = activePresets(await repo.getConfig(tenantId));
  const next = enabled ? [...new Set([...current, presetId])] : current.filter((p) => p !== presetId);
  return setPresets(repo, tenantId, next);
}

/** @deprecated single-select — use setPresets / togglePreset. */
export async function setPreset(repo: Repository, tenantId: string, presetId: string): Promise<void> {
  await setPresets(repo, tenantId, [presetId]);
}

export async function setPresetFeed(repo: Repository, tenantId: string, feedId: string, enabled: boolean): Promise<void> {
  const config = await repo.getConfig(tenantId);
  if (!config) return;
  const off = new Set(config.presetFeedsDisabled);
  if (enabled) off.delete(feedId);
  else off.add(feedId);
  await repo.saveConfig({ ...config, presetFeedsDisabled: [...off] });
}

const MAX_SOURCES_PER_TENANT = 50;

/** Add one of your own discovery sources. URLs are validated (public https only). */
export async function addSource(
  repo: Repository,
  tenantId: string,
  input: { label?: string; config: unknown },
): Promise<DiscoverySource> {
  const config = DiscoverySourceConfig.parse(input.config);
  if (config.kind === "rss" || config.kind === "json_feed") await safeUrl(config.url);
  if (config.kind === "company_list") {
    for (const c of config.companies) if (c.careersUrl) await safeUrl(c.careersUrl);
  }
  await ensureTenant(repo, tenantId);
  const existing = await repo.listDiscoverySources(tenantId);
  if (existing.length >= MAX_SOURCES_PER_TENANT) throw new Error(`You can add up to ${MAX_SOURCES_PER_TENANT} sources.`);
  const source: DiscoverySource = {
    id: randomUUID(),
    tenantId,
    label: (input.label?.trim() || defaultLabel(config)).slice(0, 120),
    config,
    configKey: createHash("sha1").update(canonicalConfigJson(config)).digest("hex"),
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastCount: null,
    lastError: null,
    createdAt: new Date(),
  };
  const saved = await repo.saveDiscoverySource(source);
  // a company list is resolved right away so its boards are polled on the next sync
  if (config.kind === "company_list") {
    await discoverCompanies(repo, config.companies.map((c) => ({ name: c.name, careersUrl: c.careersUrl ?? undefined, tags: ["added"] })));
  }
  return saved;
}

function defaultLabel(c: DiscoverySourceConfig): string {
  switch (c.kind) {
    case "rss":
    case "json_feed":
      return new URL(c.url).host;
    case "telegram":
      return `t.me/${c.channel}`;
    case "hn_thread":
      return c.storyId ? `HN thread ${c.storyId}` : "HN Who is Hiring (latest)";
    case "company_list":
      return `${c.companies.length} companies`;
  }
}

export async function setSourceEnabledById(repo: Repository, tenantId: string, id: string, enabled: boolean): Promise<void> {
  const s = (await repo.listDiscoverySources(tenantId)).find((x) => x.id === id);
  if (s) await repo.saveDiscoverySource({ ...s, enabled });
}

export async function removeDiscoverySource(repo: Repository, tenantId: string, id: string): Promise<void> {
  await repo.deleteDiscoverySource(tenantId, id);
}

/**
 * Add one company (careers URL or name): the ATS detector resolves its board and you
 * follow it. The company joins the shared registry; following is private to you.
 */
export async function addCompany(repo: Repository, tenantId: string, input: { name?: string; careersUrl?: string }) {
  if (input.careersUrl) await safeUrl(input.careersUrl);
  const name = input.name?.trim() || (input.careersUrl ? new URL(input.careersUrl).hostname.replace(/^(www|jobs|careers|boards)\./, "") : "");
  if (!name) throw new Error("Give a company name or careers URL.");
  const stats = await discoverCompanies(repo, [{ name, careersUrl: input.careersUrl, tags: ["added"] }]);
  const company = await repo.findCompanyByNameNorm(normCompany(name));
  if (company) await repo.followCompany(tenantId, company.id);
  return { company, resolved: stats.resolved > 0 };
}
