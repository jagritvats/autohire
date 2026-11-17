import { accessSync, constants, readdirSync } from "node:fs";
import type { Command } from "commander";
import { assertNeverSubmits, readFlags } from "@jobflow/autofill";
import { MIGRATIONS_DIR, type Repository } from "@jobflow/db";
import { isOfflineProvider } from "@jobflow/llm";
import { isOnboarded, loadProfile, profileReadiness } from "@jobflow/pipeline";
import { latexEngineAvailable, tenantProvider } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { CliError, SET_MODEL_HINT } from "../errors.js";
import { PLAYWRIGHT_INSTALL_HINT, playwrightStatus } from "../browser.js";

type Status = "ok" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const PROBES = ["https://boards-api.greenhouse.io/v1/boards/", "https://api.lever.co/v0/postings/"];

/** `jobflow doctor` — is everything this machine needs in place? (`--offline` skips the network) */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("doctor")
    .description("check your setup: data dir, profile, model, browser, LaTeX, network, the never-submit lock")
    .option("--offline", "skip the network checks (model test call, job-board reachability)")
    .action(async (o: { offline?: boolean }) => {
      const checks: Check[] = [];
      const add = (c: Check) => checks.push(c);

      const major = Number(process.versions.node.split(".")[0]);
      add({ name: "node", status: major >= 20 ? "ok" : "fail", detail: `v${process.versions.node}`, fix: major >= 20 ? undefined : "Install Node 20 or newer." });

      // ── storage ──
      ctx.loadEnv();
      const dir = ctx.dataDir;
      let writable = true;
      try {
        accessSync(dir, constants.W_OK);
      } catch {
        writable = false;
      }
      add({ name: "data dir", status: "ok", detail: `${dir}${writable ? "" : " (will be created)"}` });
      let repo: Repository | null = null;
      try {
        repo = await ctx.repo();
        add({ name: "store", status: "ok", detail: `${ctx.storeKind}${ctx.storeKind === "memory" ? " (throwaway — nothing persists)" : ""}` });
      } catch (e) {
        add({ name: "store", status: "fail", detail: (e as Error).message, fix: e instanceof CliError ? e.hint : undefined });
      }
      if (repo) {
        const client = (repo as { client?: { query<T>(q: string): Promise<{ rows: T[] }> } }).client;
        if (client) {
          const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length;
          const { rows } = await client.query<{ n: number | string }>("select count(*)::int as n from _migrations");
          const n = Number(rows[0]?.n ?? 0);
          add({ name: "migrations", status: n >= files ? "ok" : "warn", detail: `${n}/${files} applied` });
        }

        // ── profile ──
        const profile = await loadProfile(repo, ctx.tenantId);
        const evidence = await repo.listEvidence(ctx.tenantId);
        const r = profileReadiness(profile, evidence.length);
        if (!isOnboarded(profile)) add({ name: "profile", status: "warn", detail: "not set up", fix: "jobflow init" });
        else
          add({
            name: "profile",
            status: r.ready ? "ok" : "warn",
            detail: r.ready
              ? `${profile.prefs.stackProfile.length} skills · home ${profile.prefs.homeCountry || "—"} · ${evidence.length} evidence`
              : `missing: ${r.missing.map((m) => (m === "prefs" ? "home country / markets" : m)).join(", ")}`,
            fix: r.ready ? undefined : "jobflow profile set … (see `jobflow profile set --help`)",
          });
        add({
          name: "contact",
          status: profile.prefs.contact.email ? "ok" : "warn",
          detail: profile.prefs.contact.email ? "email set (needed to fill forms)" : "no email — forms can't be filled",
          fix: profile.prefs.contact.email ? undefined : "jobflow profile set email you@example.com",
        });
        const active = (await repo.listActivePostings()).length;
        add({ name: "corpus", status: active ? "ok" : "warn", detail: `${active} active postings`, fix: active ? undefined : "jobflow sync" });

        // ── model ──
        const config = await repo.getConfig(ctx.tenantId);
        const llm = tenantProvider(config);
        if (isOfflineProvider(llm)) {
          add({ name: "model", status: "warn", detail: "offline echo — résumés use built-in templates; cover letters/answers need a model", fix: SET_MODEL_HINT });
        } else if (o.offline) {
          add({ name: "model", status: "skip", detail: `${llm.name} (test call skipped: --offline)` });
        } else {
          try {
            await llm.complete({ prompt: "Reply with the single word OK.", maxTokens: 8, timeoutMs: 20_000, retries: 0 });
            add({ name: "model", status: "ok", detail: `${llm.name}${config?.llmModel ? ` · ${config.llmModel}` : ""} answered a test call` });
          } catch (e) {
            const pe = e as Error & { userMessage?: string };
            add({ name: "model", status: "fail", detail: `${llm.name}: ${pe.userMessage ?? pe.message}`, fix: "check: jobflow config list (key / model / base URL)" });
          }
        }
        const fillOn = config?.automationFlags.browser === "on" && config.automationFlags.mode === "fill";
        add({ name: "form fill", status: "ok", detail: fillOn ? "on (apply --fill allowed)" : "off (apply --fill asks you to enable it)" });
      }

      // ── local tools ──
      const pw = await playwrightStatus();
      add(
        pw.installed && pw.chromium
          ? { name: "playwright", status: "ok", detail: `v${pw.version} + chromium` }
          : pw.installed
            ? { name: "playwright", status: "warn", detail: `v${pw.version}, chromium missing`, fix: "npx playwright install chromium" }
            : { name: "playwright", status: "warn", detail: "not installed (only needed for apply --fill)", fix: PLAYWRIGHT_INSTALL_HINT },
      );
      const tex = await latexEngineAvailable();
      add(tex ? { name: "latex", status: "ok", detail: tex } : { name: "latex", status: "warn", detail: "no engine (only needed for tailor --pdf)", fix: "install tectonic: https://tectonic-typesetting.github.io" });

      // ── network ──
      if (o.offline) add({ name: "network", status: "skip", detail: "--offline" });
      else {
        const results = await Promise.all(PROBES.map(probe));
        const okN = results.filter((x) => x.ok).length;
        add({
          name: "network",
          status: okN === PROBES.length ? "ok" : okN ? "warn" : "fail",
          detail: results.map((x) => `${new URL(x.url).host} ${x.ok ? `${x.status}` : `✗ ${x.error}`}`).join(" · "),
          fix: okN === PROBES.length ? undefined : "job sources are fetched live — check your connection / proxy",
        });
      }

      // ── the never-submit lock (invariant #2) ──
      const flags = readFlags(ctx.io.env);
      let locked = flags.autosubmit === false;
      try {
        assertNeverSubmits(flags);
      } catch {
        locked = false;
      }
      add({ name: "autosubmit", status: locked ? "ok" : "fail", detail: locked ? "locked off — JobFlow never submits an application" : "UNLOCKED — this must never happen" });

      const failed = checks.some((c) => c.status === "fail");
      if (failed) ctx.exitCode = 1;
      ctx.out.emit({ ok: !failed, checks }, () => {
        const out = ctx.out;
        const icon = (s: Status) => (s === "ok" ? out.green("✓") : s === "warn" ? out.yellow("!") : s === "fail" ? out.red("✗") : out.dim("-"));
        for (const c of checks) {
          out.line(`${icon(c.status)} ${c.name.padEnd(11)} ${c.detail}`);
          if (c.fix && c.status !== "ok") out.line(`  ${" ".repeat(11)} ${out.dim(`→ ${c.fix}`)}`);
        }
      });
    });
}

async function probe(url: string): Promise<{ url: string; ok: boolean; status?: number; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, headers: { "User-Agent": "JobFlow/0.1 (doctor)" } });
    void res.body?.cancel();
    return { url, ok: true, status: res.status };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { url, ok: false, error: err.name === "AbortError" ? "timeout" : err.cause?.code ?? err.message };
  } finally {
    clearTimeout(t);
  }
}
