import type { Command } from "commander";
import { LlmChoice, activePresets, type TenantConfig } from "@jobflow/core";
import { listPresets } from "@jobflow/pipeline";
import { setPresets, tenantProvider } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { notFound, usage } from "../errors.js";
import { mask } from "../output.js";
import { presetIds } from "./shared.js";

/**
 * Settings that live in your TenantConfig (in the local database under the data dir —
 * never in the repo). The LLM key is read from stdin with --stdin so it never lands in
 * shell history, and it is only ever shown masked.
 */

interface KeyDef {
  help: string;
  get(c: TenantConfig): string;
  set(c: TenantConfig, v: string): TenantConfig;
  secret?: boolean;
}

const onOff = (v: string): boolean => {
  if (/^(on|yes|true|1)$/i.test(v.trim())) return true;
  if (/^(off|no|false|0|)$/i.test(v.trim())) return false;
  throw usage(`expected on or off (got "${v}")`);
};

export const KEYS: Record<string, KeyDef> = {
  "llm.provider": {
    help: `generation provider: ${LlmChoice.options.join(" | ")} (echo = offline, no prose)`,
    get: (c) => c.llmChoice,
    set: (c, v) => {
      const r = LlmChoice.safeParse(v.trim().toLowerCase() || "echo");
      if (!r.success) throw usage(`unknown provider "${v}"`, `Use: ${LlmChoice.options.join(", ")}`);
      return { ...c, llmChoice: r.data };
    },
  },
  "llm.model": { help: "model id override (blank = the provider's default)", get: (c) => c.llmModel, set: (c, v) => ({ ...c, llmModel: v.trim() }) },
  "llm.key": { help: "API key for the provider (use --stdin)", secret: true, get: (c) => c.llmApiKey, set: (c, v) => ({ ...c, llmApiKey: v.trim() }) },
  "llm.baseUrl": { help: "custom base URL / gateway (blank = default)", get: (c) => c.llmBaseUrl, set: (c, v) => ({ ...c, llmBaseUrl: v.trim() }) },
  "automation.fill": {
    help: "allow `jobflow apply --fill` to type into forms in a local browser (on|off). It never submits.",
    get: (c) => (c.automationFlags.browser === "on" && c.automationFlags.mode === "fill" ? "on" : "off"),
    set: (c, v) => {
      const on = onOff(v);
      return { ...c, automationFlags: { ...c.automationFlags, browser: on ? "on" : "off", mode: on ? "fill" : "capture", autosubmit: false } };
    },
  },
  "automation.rate": {
    help: "pace of the form-filler: human (default) | fast",
    get: (c) => c.automationFlags.rate,
    set: (c, v) => {
      const r = v.trim().toLowerCase();
      if (r !== "human" && r !== "fast") throw usage(`rate must be human or fast (got "${v}")`);
      return { ...c, automationFlags: { ...c.automationFlags, rate: r } };
    },
  },
  "discovery.presets": {
    help: `discovery presets switched on, comma-separated: ${listPresets().map((p) => p.id).join(", ")}`,
    get: (c) => activePresets(c).join(","),
    set: (c) => c, // handled by setPresets (validates the ids)
  },
};

async function config(ctx: Ctx): Promise<TenantConfig> {
  const c = await (await ctx.repo()).getConfig(ctx.tenantId);
  if (!c) throw notFound("No config yet.");
  return c;
}

function keyDef(key: string): KeyDef {
  const def = KEYS[key === "discovery.preset" ? "discovery.presets" : key];
  if (!def) throw usage(`unknown config key "${key}"`, `Keys: ${Object.keys(KEYS).join(", ")}`);
  return def;
}

const shown = (def: KeyDef, v: string) => (def.secret ? mask(v) : v);

export function register(program: Command, ctx: Ctx): void {
  const cfg = program.command("config").description("settings: generation model + key, form-filler, discovery presets");
  const keysHelp = "\nKeys:\n" + Object.entries(KEYS).map(([k, d]) => `  ${k.padEnd(18)} ${d.help}`).join("\n");

  cfg.command("list", { isDefault: true })
    .description("show all settings (the key is masked)")
    .action(async () => {
      const c = await config(ctx);
      const llm = tenantProvider(c);
      const rows = Object.entries(KEYS).map(([k, d]) => ({ key: k, value: shown(d, d.get(c)) }));
      ctx.out.emit({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])), effectiveProvider: llm.name }, () => {
        ctx.out.table(["key", "value"], rows.map((r) => [r.key, r.value || ctx.out.dim("(default)")]));
        ctx.out.line();
        ctx.out.line(`generation runs on: ${llm.name === "echo" ? ctx.out.yellow("echo (offline — documents are built-in templates, prose needs a model)") : ctx.out.green(llm.name)}`);
      });
    })
    .addHelpText("after", keysHelp);

  cfg.command("get")
    .description("print one setting")
    .argument("<key>")
    .addHelpText("after", keysHelp)
    .action(async (key: string) => {
      const def = keyDef(key);
      const v = shown(def, def.get(await config(ctx)));
      ctx.out.emit({ key, value: v }, () => ctx.out.line(v));
    });

  cfg.command("set")
    .description("change a setting")
    .argument("<key>")
    .argument("[value]")
    .option("--stdin", "read the value from stdin (for llm.key: keeps it out of shell history)")
    .addHelpText("after", keysHelp + '\n\nExample:\n  jobflow config set llm.provider anthropic\n  printf %s "$ANTHROPIC_API_KEY" | jobflow config set llm.key --stdin')
    .action(async (key: string, value: string | undefined, o: { stdin?: boolean }) => {
      const def = keyDef(key);
      let v = value;
      if (o.stdin) v = (await ctx.readStdin()).trim();
      else if (v == null && def.secret && ctx.io.stdinIsTTY) v = await ctx.secret(`${key} (input hidden): `);
      if (v == null) throw usage(`give a value for ${key}${def.secret ? " (use --stdin for the key)" : ""}`);
      if (def.secret && value != null && !o.stdin) ctx.out.warn("a key passed as an argument is saved in your shell history — prefer `--stdin` next time.");
      const repo = await ctx.repo();
      if (key.startsWith("discovery.preset")) await setPresets(repo, ctx.tenantId, presetIds(v));
      else await repo.saveConfig(def.set(await config(ctx), v));
      const after = await config(ctx);
      ctx.out.emit({ ok: true, key, value: shown(def, def.get(after)) }, () => {
        ctx.out.ok(`${key} = ${shown(def, def.get(after)) || "(default)"}`);
        if (key === "llm.key" && after.llmChoice === "echo") ctx.out.hint("Now pick the provider it belongs to: jobflow config set llm.provider anthropic");
        if (key === "llm.provider" && after.llmChoice !== "echo" && !after.llmApiKey && !after.llmBaseUrl) ctx.out.hint("Add its key: jobflow config set llm.key --stdin");
        if (key.startsWith("llm.")) ctx.out.hint("Check it works: jobflow doctor");
      });
    });

  cfg.command("unset")
    .description("reset a setting to its default")
    .argument("<key>")
    .action(async (key: string) => {
      const def = keyDef(key);
      const repo = await ctx.repo();
      if (key.startsWith("discovery.preset")) throw usage("pick presets instead: jobflow discovery use <preset,preset>");
      await repo.saveConfig(def.set(await config(ctx), key === "llm.provider" ? "echo" : key === "automation.fill" ? "off" : key === "automation.rate" ? "human" : ""));
      ctx.out.emit({ ok: true, key }, () => ctx.out.ok(`${key} reset`));
    });
}
