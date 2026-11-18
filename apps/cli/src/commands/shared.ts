import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  LevelBand,
  RemoteGeo,
  RoleArchetype,
  countryDisplayName,
  formatAmount,
  resolveDisplayCurrency,
  matchSkillToken,
  type Profile,
} from "@jobflow/core";
import { isOnboarded, listPresets, loadProfile, makeSearchQuery, profileReadiness } from "@jobflow/pipeline";
import type { Ctx } from "../context.js";
import { CliError, EXIT, needsSetup, usage } from "../errors.js";
import type { Out } from "../output.js";

/** "a, b;c" → ["a","b","c"] */
export function csv(v: string | string[] | undefined | null): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x).split(/[,;]/))
    .map((x) => x.trim())
    .filter(Boolean);
}

/** "us, eu-uk" → validated discovery-preset ids (multi-select; also used as search/feed tags) */
export function presetIds(v: string | string[] | undefined): string[] {
  const known = listPresets().map((p) => p.id);
  const ids = [...new Set(csv(v).map((p) => p.toLowerCase()))];
  for (const id of ids) if (!known.includes(id)) throw usage(`unknown preset "${id}"`, `Presets: ${known.join(", ")}`);
  return ids;
}

/** commander collector for repeatable options */
export const collect = (v: string, prev: string[] = []) => [...prev, v];

/** ISO-2 country code (upper-case) or a usage error */
export function countryCode(v: string, what = "country"): string {
  const c = v.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw usage(`${what} must be a 2-letter ISO code like US, IN, DE (got "${v}")`);
  return c;
}

export function countryList(v: string | undefined): string[] {
  return [...new Set(csv(v).map((c) => countryCode(c, "market")))];
}

export function remoteGeos(v: string): RemoteGeo[] {
  const geos = csv(v).map((g) => g.toLowerCase().replace(/[\s-]/g, "_"));
  const ok = RemoteGeo.options as readonly string[];
  for (const g of geos) if (!ok.includes(g)) throw usage(`unknown remote geo "${g}"`, `Use: ${ok.filter((x) => x !== "unknown").join(", ")}`);
  return [...new Set(geos)] as RemoteGeo[];
}

export function archetypes(v: string): RoleArchetype[] {
  const alias: Record<string, string> = { devops: "infra_devops", infra: "infra_devops", data: "data_ml", ml: "data_ml", analytics: "data_analytics", analyst: "data_analytics", bi: "data_analytics", "full-stack": "fullstack", "full_stack": "fullstack" };
  const ok = RoleArchetype.options as readonly string[];
  const out = csv(v).map((r) => {
    const k = r.toLowerCase().replace(/\s+/g, "_");
    const v2 = alias[k] ?? k;
    if (!ok.includes(v2)) throw usage(`unknown role type "${r}"`, `Use: ${ok.join(", ")}`);
    return v2 as RoleArchetype;
  });
  return [...new Set(out)];
}

export function levelBand(v: string): LevelBand {
  const r = LevelBand.safeParse(v.trim().toLowerCase());
  if (!r.success) throw usage(`unknown level "${v}"`, `Use: ${LevelBand.options.join(", ")}`);
  return r.data;
}

export function yoeValue(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 60) throw usage(`years of experience must be a number 0–60 (got "${v}")`);
  return Math.round(n * 10) / 10;
}

/**
 * "150000 USD" / "150k USD" / "$150k" / "40L INR" → amount + currency — the same money
 * parser `jobflow search --min-salary` uses.
 */
export function money(v: string, currency?: string): { amount: number; currency: string } {
  const q = makeSearchQuery("", { minSalary: v.trim(), currency });
  if (!q.minSalary) throw usage(`couldn't read "${v}" as an amount`, `Try "150000 USD", "150k USD" or "40L INR".`);
  return q.minSalary;
}

/**
 * Skills → canonical ids where the dictionary knows them ("PostgreSQL" → "postgres");
 * unknown ones are kept as typed (lower-cased) and reported, never guessed.
 */
export function skills(v: string | string[]): { skills: string[]; unknown: string[] } {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const t of csv(v)) {
    const c = matchSkillToken(t);
    if (c) out.push(c);
    else {
      out.push(t.toLowerCase());
      unknown.push(t);
    }
  }
  return { skills: [...new Set(out)], unknown };
}

/** "Berlin, Remote, London" → ranked location weights (first = 1.0, then −0.1 each, ≥ 0.5) */
export function locationWeights(v: string): Array<{ label: string; weight: number }> {
  return csv(v)
    .map((l) => l.toLowerCase())
    .map((label, i) => ({ label, weight: Math.round(Math.max(0.5, 1 - i * 0.1) * 100) / 100 }));
}

export function yesNo(v: string): boolean {
  if (/^(y|yes|true|on|1)$/i.test(v.trim())) return true;
  if (/^(n|no|false|off|0)$/i.test(v.trim())) return false;
  throw usage(`expected yes or no (got "${v}")`);
}

/** read a file the user named (relative to where they ran the command) */
export async function readUserFile(ctx: Ctx, path: string): Promise<{ filename: string; bytes: Uint8Array; abs: string }> {
  const abs = ctx.userPath(path);
  try {
    return { filename: basename(abs), bytes: new Uint8Array(await readFile(abs)), abs };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CliError(code === "ENOENT" ? `No such file: ${abs}` : `Can't read ${abs}: ${(e as Error).message}`, code === "ENOENT" ? EXIT.notFound : EXIT.error);
  }
}

export async function profileOf(ctx: Ctx): Promise<Profile> {
  return loadProfile(await ctx.repo(), ctx.tenantId);
}

/** the profile, or exit 4 with the way to set it up */
export async function requireProfile(ctx: Ctx): Promise<Profile> {
  const p = await profileOf(ctx);
  if (!isOnboarded(p)) throw needsSetup("You haven't set up your profile yet.", "Run `jobflow init` (or `jobflow init --sample` to try the fictional demo persona).");
  return p;
}

export function fullName(p: Profile): string {
  return [p.prefs.contact.firstName, p.prefs.contact.lastName].filter((s) => s.trim()).join(" ");
}

export function money2(n: number, cur: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

/** The profile summary `jobflow me` / `init` show. */
export function printProfile(out: Out, p: Profile, evidenceCount: number): void {
  const c = p.prefs.contact;
  const r = profileReadiness(p, evidenceCount);
  const kv = (k: string, v: string) => out.line(`  ${out.dim(k.padEnd(12))} ${v || out.dim("—")}`);
  out.line(out.bold(fullName(p) || "(no name yet)") + (p.prefs.contact.email ? out.dim(`  <${c.email}>`) : ""));
  kv("experience", `${p.yoe} yrs · ${p.levelBand}`);
  kv("skills", p.prefs.stackProfile.join(", "));
  if (p.prefs.stackMustHaves.length) kv("must-haves", p.prefs.stackMustHaves.join(", "));
  kv("roles", p.prefs.targetArchetypes.join(", "));
  kv("home", p.prefs.homeCountry ? `${p.prefs.homeCountry} (${countryDisplayName(p.prefs.homeCountry)})` : "");
  kv("markets", p.prefs.markets.join(", "));
  kv("remote ok", p.prefs.remoteGeoOk.join(", "));
  kv("relocate", p.prefs.relocate ? "yes" : "no");
  kv("salary floor", p.prefs.salaryFloor > 0 ? formatAmount(p.prefs.salaryFloor, p.prefs.currency) : "");
  const showIn = resolveDisplayCurrency(p.prefs);
  kv("pay shown", `${showIn ? `the posting's currency + ≈ ${showIn}` : "the posting's currency only"} · per ${p.prefs.display.period}`);
  kv("locations", p.prefs.locationWeights.map((l) => l.label).join(", "));
  kv("contact", [c.phone, c.linkedin, c.github, c.portfolio].filter(Boolean).join(" · "));
  kv("résumé", p.resumeFile ? `${p.resumeFile.filename}${c.resumePath ? out.dim(`  (${c.resumePath})`) : ""}` : c.resumePath || (p.masterResume.trim() ? "text only (no file to attach)" : ""));
  kv("evidence", `${evidenceCount} item(s)`);
  if (!r.ready) out.line(`  ${out.yellow("missing")}      ${r.missing.map((m) => (m === "prefs" ? "home country / markets" : m)).join(", ")}`);
}
