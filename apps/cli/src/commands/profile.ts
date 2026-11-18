import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { Contact, LevelBand, ProfilePrefs, type Profile } from "@jobflow/core";
import { loadProfile, profileReadiness } from "@jobflow/pipeline";
import { finishOnboarding, importResume } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import {
  archetypes,
  countryCode,
  countryList,
  levelBand,
  locationWeights,
  money,
  printProfile,
  readUserFile,
  remoteGeos,
  skills as parseSkills,
  yesNo,
  yoeValue,
} from "./shared.js";

/**
 * "Set my details" in one line: `jobflow profile set email alex@example.com`,
 * `jobflow profile set skills "go,postgres,kafka"`, `jobflow profile set home US`.
 * Each field maps to exactly one profile value; nothing here invents data (invariant #3).
 */

interface FieldDef {
  help: string;
  /** apply a value to the profile (returns the new profile) */
  set(p: Profile, v: string, ctx: Ctx): Profile | Promise<Profile>;
  /** the field changes what matching sees → reset the profile embedding */
  rerank?: boolean;
}

const contactField = (k: keyof Contact, help: string): FieldDef => ({
  help,
  set: (p, v) => ({ ...p, prefs: { ...p.prefs, contact: { ...p.prefs.contact, [k]: v.trim() } } }),
});
const prefs = (p: Profile, patch: Partial<Profile["prefs"]>): Profile => ({ ...p, prefs: { ...p.prefs, ...patch } });

/** `+go,rust` adds, `-java` removes, anything else replaces */
function editList(current: string[], v: string, parse: (s: string) => string[]): string[] {
  const t = v.trim();
  if (t.startsWith("+")) return [...new Set([...current, ...parse(t.slice(1))])];
  if (t.startsWith("-")) {
    const drop = new Set(parse(t.slice(1)));
    return current.filter((x) => !drop.has(x));
  }
  return parse(t);
}

export const FIELDS: Record<string, FieldDef> = {
  name: {
    help: 'full name, e.g. "Sam Placeholder"',
    set: (p, v) => {
      const [first = "", ...rest] = v.trim().split(/\s+/);
      return { ...p, prefs: { ...p.prefs, contact: { ...p.prefs.contact, firstName: first, lastName: rest.join(" ") } } };
    },
  },
  first: contactField("firstName", "first name"),
  last: contactField("lastName", "last name"),
  email: contactField("email", "email for applications"),
  phone: contactField("phone", "phone for applications"),
  linkedin: contactField("linkedin", "LinkedIn URL"),
  github: contactField("github", "GitHub URL"),
  portfolio: contactField("portfolio", "portfolio / website URL"),
  "resume-path": {
    help: "a résumé file to attach when filling forms (default: the one you imported)",
    set: (p, v, ctx) => ({ ...p, prefs: { ...p.prefs, contact: { ...p.prefs.contact, resumePath: v.trim() ? ctx.userPath(v.trim()) : "" } } }),
  },
  skills: {
    help: 'your stack, e.g. "go,postgres,kafka" (+x adds, -x removes)',
    rerank: true,
    set: (p, v, ctx) => {
      let unknown: string[] = [];
      const parse = (s: string) => {
        const r = parseSkills(s);
        unknown = r.unknown;
        return r.skills;
      };
      const next = editList(p.prefs.stackProfile, v, parse);
      if (unknown.length) ctx.out.warn(`kept as typed (not in the skills dictionary): ${unknown.join(", ")}`);
      return prefs(p, { stackProfile: next });
    },
  },
  "must-haves": {
    help: "skills a role must use to rank well (weighted, never a hard filter)",
    rerank: true,
    set: (p, v) => prefs(p, { stackMustHaves: editList(p.prefs.stackMustHaves, v, (s) => parseSkills(s).skills) }),
  },
  roles: {
    help: "target role types: backend,platform,fullstack,infra_devops,data_ml,data_analytics,frontend,mobile,sre (data_ml alone also covers analytics roles)",
    rerank: true,
    set: (p, v) => prefs(p, { targetArchetypes: editList(p.prefs.targetArchetypes, v, archetypes) as Profile["prefs"]["targetArchetypes"] }),
  },
  yoe: { help: "years of experience", rerank: true, set: (p, v) => ({ ...p, yoe: yoeValue(v) }) },
  level: { help: `seniority: ${LevelBand.options.join("|")}`, rerank: true, set: (p, v) => ({ ...p, levelBand: levelBand(v) }) },
  home: { help: "home country, ISO-2 (US, IN, DE…)", rerank: true, set: (p, v) => prefs(p, { homeCountry: v.trim() ? countryCode(v, "home") : "" }) },
  markets: { help: "countries to search, ISO-2 list (US,CA)", rerank: true, set: (p, v) => prefs(p, { markets: countryList(v) }) },
  remote: {
    help: "remote regions you can work in: worldwide,us_only,eu_only,us_eu,india_ok,apac_ok",
    rerank: true,
    set: (p, v) => prefs(p, { remoteGeoOk: remoteGeos(v) }),
  },
  relocate: { help: "yes | no", rerank: true, set: (p, v) => prefs(p, { relocate: yesNo(v) }) },
  floor: {
    help: 'salary floor, e.g. "150000 USD" (0 clears)',
    rerank: true,
    set: (p, v) => {
      if (/^(0|none|off)$/i.test(v.trim())) return prefs(p, { salaryFloor: 0 });
      const m = money(v, p.prefs.currency);
      return prefs(p, { salaryFloor: m.amount, currency: m.currency });
    },
  },
  currency: {
    help: "currency for your floor (USD, EUR, INR…)",
    rerank: true,
    set: (p, v) => {
      if (!/^[A-Za-z]{3}$/.test(v.trim())) throw usage(`currency must be a 3-letter code (got "${v}")`);
      return prefs(p, { currency: v.trim().toUpperCase() });
    },
  },
  locations: { help: "preferred places, most preferred first (Remote, Berlin)", rerank: true, set: (p, v) => prefs(p, { locationWeights: locationWeights(v) }) },
  about: { help: "a short 'about me' in your own words (grounds generation)", set: (p, v) => ({ ...p, aboutText: v.trim() }) },
};

export function register(program: Command, ctx: Ctx): void {
  program
    .command("me")
    .description("show your profile (same as `profile show`)")
    .action(() => show(ctx));

  const profile = program.command("profile").description("your details: show, set a field, import a résumé, edit as JSON");
  profile.command("show", { isDefault: true }).description("show your profile").action(() => show(ctx));

  profile
    .command("set")
    .description("set one field")
    .argument("<field>", Object.keys(FIELDS).join(" | "))
    .argument("[value...]", "the value (quote it if it has spaces)")
    .addHelpText("after", "\nFields:\n" + Object.entries(FIELDS).map(([k, f]) => `  ${k.padEnd(12)} ${f.help}`).join("\n"))
    .action(async (field: string, value: string[]) => {
      const def = FIELDS[field.toLowerCase()];
      if (!def) throw usage(`unknown field "${field}"`, `Fields: ${Object.keys(FIELDS).join(", ")}`);
      const v = value.join(" ");
      const repo = await ctx.repo();
      const current = await loadProfile(repo, ctx.tenantId);
      const next = await def.set(current, v, ctx);
      const saved = await repo.saveProfile({ ...next, profileEmbedding: def.rerank ? null : next.profileEmbedding });
      ctx.out.emit({ ok: true, field, profile: saved }, () => {
        ctx.out.ok(`${field} updated`);
        if (def.rerank) ctx.out.hint("Re-score your feed with `jobflow rank`.");
      });
    });

  profile
    .command("import")
    .description("import a résumé into your profile + Evidence Bank (replaces your base résumé unless --merge)")
    .argument("<file>", "pdf/docx/tex/md/txt/json, a LinkedIn export .zip, or - for text on stdin")
    .option("--merge", "fill gaps and union skills instead of replacing")
    .option("--assist", "also run the grounded LLM-assisted extraction (needs a model)")
    .action(async (file: string, o: { merge?: boolean; assist?: boolean }) => {
      const repo = await ctx.repo();
      const spin = ctx.out.spinner("Reading your résumé");
      const imp =
        file === "-"
          ? await importResume(repo, ctx.files(), ctx.tenantId, { text: await ctx.readStdin(), assist: o.assist }).finally(() => spin.stop())
          : await readUserFile(ctx, file)
              .then((f) => importResume(repo, ctx.files(), ctx.tenantId, { file: { filename: f.filename, bytes: f.bytes }, assist: o.assist }))
              .finally(() => spin.stop());
      const r = await finishOnboarding(repo, ctx.files(), ctx.tenantId, { draft: imp.draft, file: imp.file, mode: o.merge ? "merge" : "replace" });
      ctx.out.emit({ ok: true, evidenceAdded: r.evidenceAdded, readiness: r.readiness, warnings: imp.draft.warnings, assisted: imp.assisted }, () => {
        for (const w of imp.draft.warnings) ctx.out.warn(w);
        ctx.out.ok(`Imported ${imp.draft.format} résumé (${o.merge ? "merged" : "replaced"}) · ${imp.draft.skills.canonical.length} skills · ${r.evidenceAdded} new evidence item(s)`);
        ctx.out.hint("Check it with `jobflow me`, then `jobflow rank`.");
      });
    });

  profile
    .command("edit")
    .description("edit your profile as JSON in $EDITOR (validated before saving)")
    .action(async () => {
      const repo = await ctx.repo();
      const current = await loadProfile(repo, ctx.tenantId);
      const editor = ctx.io.env.VISUAL || ctx.io.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      const dir = mkdtempSync(join(tmpdir(), "jobflow-profile-"));
      const file = join(dir, "profile.json");
      try {
        writeFileSync(file, JSON.stringify(editable(current), null, 2) + "\n", { mode: 0o600 });
        const r = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
        if (r.status !== 0) throw new CliError(`${editor} exited with ${r.status ?? r.signal}; nothing saved.`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch (e) {
          throw usage(`That isn't valid JSON (${(e as Error).message}); nothing saved.`);
        }
        const v = Editable.parse(parsed);
        const next: Profile = {
          ...current,
          yoe: v.yoe,
          levelBand: v.levelBand,
          aboutText: v.aboutText,
          profileEmbedding: null,
          prefs: { ...current.prefs, ...v.prefs, contact: { ...current.prefs.contact, ...v.contact } },
        };
        await repo.saveProfile(next);
        ctx.out.emit({ ok: true }, () => ctx.out.ok("Profile saved. Re-score with `jobflow rank`."));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
}

/** The editable slice of the profile, validated with the core Zod schemas. */
const Editable = z
  .object({
    contact: Contact.omit({ resumePath: true }),
    yoe: z.number().min(0).max(60),
    levelBand: LevelBand,
    aboutText: z.string().default(""),
    prefs: ProfilePrefs.omit({ contact: true }),
  })
  .strict();

function editable(p: Profile): z.input<typeof Editable> {
  const { resumePath: _r, ...contact } = p.prefs.contact;
  const { contact: _c, ...prefs } = p.prefs;
  return { contact, yoe: p.yoe, levelBand: p.levelBand, aboutText: p.aboutText, prefs };
}

async function show(ctx: Ctx): Promise<void> {
  const repo = await ctx.repo();
  const p = await loadProfile(repo, ctx.tenantId);
  const evidence = await repo.listEvidence(ctx.tenantId);
  const readiness = profileReadiness(p, evidence.length);
  const onboarded = p.onboardedAt != null;
  ctx.out.emit(
    {
      onboarded,
      readiness,
      evidenceCount: evidence.length,
      profile: { ...p, profileEmbedding: undefined, masterResume: p.masterResume ? `${p.masterResume.length} chars` : "" },
    },
    () => {
      if (!onboarded && !p.masterResume.trim() && !p.prefs.stackProfile.length) {
        ctx.out.line("No profile yet.");
        ctx.out.hint("Run `jobflow init` to set your details (or `jobflow init --sample` for the fictional demo persona).");
        return;
      }
      printProfile(ctx.out, p, evidence.length);
    },
  );
}
