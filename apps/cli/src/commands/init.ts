import type { Command } from "commander";
import {
  LevelBand,
  RoleArchetype,
  countryCodeFromText,
  remoteGeosForCountry,
  type Contact,
  type ProfilePrefs,
  type ResumeDraft,
  type StoredFile,
} from "@jobflow/core";
import { listPresets, loadProfile, suggestPreset, isOnboarded } from "@jobflow/pipeline";
import { finishOnboarding, importResume, loadSampleProfile } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { usage } from "../errors.js";
import {
  archetypes,
  countryCode,
  countryList,
  fullName,
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

interface InitOpts {
  yes?: boolean;
  sample?: boolean;
  resume?: string;
  assist?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  skills?: string;
  yoe?: string;
  level?: string;
  home?: string;
  markets?: string;
  remote?: string;
  relocate?: boolean;
  floor?: string;
  roles?: string;
  locations?: string;
  preset?: string;
  force?: boolean;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("init")
    .description("set up your profile: résumé → reviewed details → preferences → discovery preset")
    .option("-y, --yes", "non-interactive: take the flags (and what the résumé says) without asking")
    .option("--sample", "use the FICTIONAL demo persona (Alex Example) instead of your own résumé")
    .option("--resume <file>", "your résumé: .pdf .docx .tex .md .txt .json (JSON Resume) or a LinkedIn export .zip; - reads text from stdin")
    .option("--assist", "also run the grounded LLM-assisted extraction (needs a model)")
    .option("--name <full name>", "your name as it should appear on applications")
    .option("--email <email>")
    .option("--phone <phone>")
    .option("--linkedin <url>")
    .option("--github <url>")
    .option("--portfolio <url>")
    .option("--skills <list>", "comma-separated (replaces what the résumé found)")
    .option("--yoe <years>", "years of experience")
    .option("--level <band>", `one of ${LevelBand.options.join("|")}`)
    .option("--home <CC>", "home country, ISO-2 (US, IN, DE…)")
    .option("--markets <list>", "countries to search, ISO-2, e.g. US,CA")
    .option("--remote <geos>", "remote regions you can work in: worldwide,us_only,eu_only,us_eu,india_ok,apac_ok")
    .option("--relocate", "open to relocating")
    .option("--no-relocate", "not open to relocating")
    .option("--floor <amount>", 'salary floor, e.g. "150000 USD" (only a confidently-stated lower salary is excluded)')
    .option("--roles <list>", `target role types: ${RoleArchetype.options.filter((r) => r !== "other").join(",")}`)
    .option("--locations <list>", "preferred cities/regions, most preferred first")
    .option("--preset <id>", `discovery preset: ${listPresets().map((p) => p.id).join(" | ")}`)
    .option("--force", "re-run onboarding without asking even if you're set up")
    .action(async (opts: InitOpts) => {
      const res = opts.yes ? await initNonInteractive(ctx, opts) : await initInteractive(ctx, opts);
      const out = ctx.out;
      const repo = await ctx.repo();
      const profile = await loadProfile(repo, ctx.tenantId);
      const evidence = await repo.listEvidence(ctx.tenantId);
      out.emit(
        { ok: true, sample: !!opts.sample, evidenceAdded: res.evidenceAdded, readiness: res.readiness, preset: res.preset, profile: { name: fullName(profile), email: profile.prefs.contact.email } },
        () => {
          out.line();
          printProfile(out, profile, evidence.length);
          out.line();
          out.ok(`Profile saved${opts.sample ? " (fictional sample persona)" : ""} · discovery preset: ${res.preset}`);
          if (!res.readiness.ready) out.hint(`Still missing: ${res.readiness.missing.join(", ")} — fix with \`jobflow profile set …\``);
          out.line(`next: ${out.bold("jobflow sync && jobflow feed")}   ${out.dim('(or: jobflow search "backend engineer" --remote)')}`);
        },
      );
    });
}

interface InitResult {
  evidenceAdded: number;
  readiness: { ready: boolean; missing: string[] };
  preset: string;
}

/** What the flags say, as an onboarding patch (only flags that were given). */
function flagPatch(opts: InitOpts): { contact: Partial<Contact>; prefs: Partial<ProfilePrefs>; yoe?: number; levelBand?: LevelBand; stackProfile?: string[]; unknownSkills: string[] } {
  const contact: Partial<Contact> = {};
  if (opts.name) {
    const parts = opts.name.trim().split(/\s+/);
    contact.firstName = parts[0] ?? "";
    contact.lastName = parts.slice(1).join(" ");
  }
  for (const k of ["email", "phone", "linkedin", "github", "portfolio"] as const) if (opts[k] != null) contact[k] = opts[k]!.trim();
  const prefs: Partial<ProfilePrefs> = {};
  if (opts.home) prefs.homeCountry = countryCode(opts.home, "home");
  if (opts.markets) prefs.markets = countryList(opts.markets);
  if (opts.remote) prefs.remoteGeoOk = remoteGeos(opts.remote);
  if (opts.relocate != null) prefs.relocate = opts.relocate;
  if (opts.floor) {
    const m = money(opts.floor);
    prefs.salaryFloor = m.amount;
    prefs.currency = m.currency;
  }
  if (opts.roles) prefs.targetArchetypes = archetypes(opts.roles);
  if (opts.locations) prefs.locationWeights = locationWeights(opts.locations);
  const sk = opts.skills ? parseSkills(opts.skills) : null;
  return {
    contact,
    prefs,
    yoe: opts.yoe != null ? yoeValue(opts.yoe) : undefined,
    levelBand: opts.level ? levelBand(opts.level) : undefined,
    stackProfile: sk?.skills,
    unknownSkills: sk?.unknown ?? [],
  };
}

async function importFrom(ctx: Ctx, opts: InitOpts): Promise<{ draft: ResumeDraft; file: StoredFile | null } | null> {
  if (!opts.resume) return null;
  const repo = await ctx.repo();
  const spin = ctx.out.spinner("Reading your résumé");
  try {
    const r =
      opts.resume === "-"
        ? await importResume(repo, ctx.files(), ctx.tenantId, { text: await ctx.readStdin(), assist: opts.assist })
        : await (async () => {
            const f = await readUserFile(ctx, opts.resume!);
            return importResume(repo, ctx.files(), ctx.tenantId, { file: { filename: f.filename, bytes: f.bytes }, assist: opts.assist });
          })();
    spin.stop();
    return { draft: r.draft, file: r.file };
  } catch (e) {
    spin.stop();
    throw e;
  }
}

function homeFromDraft(draft: ResumeDraft | null): string {
  for (const l of draft?.locations ?? []) {
    const c = countryCodeFromText(l);
    if (c) return c;
  }
  return "";
}

/** A short readout of what was extracted — the user confirms before anything is saved. */
function printDraft(ctx: Ctx, draft: ResumeDraft): void {
  const out = ctx.out;
  const c = draft.contact;
  out.note("");
  out.note(out.bold("From your résumé") + out.dim(` (${draft.format}${draft.provenance === "llm_assisted" ? ", model-assisted" : ""})`));
  out.note(`  name       ${[c.firstName, c.lastName].filter(Boolean).join(" ") || out.dim("—")}   ${c.email ?? ""}`);
  out.note(`  skills     ${draft.skills.canonical.slice(0, 15).join(", ") || out.dim("—")}${draft.skills.canonical.length > 15 ? out.dim(` +${draft.skills.canonical.length - 15}`) : ""}`);
  out.note(`  experience ${draft.yoe.value} yrs${draft.yoe.basis ? out.dim(` (${draft.yoe.basis})`) : ""} · level ${draft.levelBand.value}`);
  out.note(`  roles      ${draft.roles.slice(0, 3).map((r) => `${r.title} @ ${r.company}`).join("; ") || out.dim("—")}`);
  out.note(`  evidence   ${draft.evidence.filter((e) => e.selected).length} item(s) for your Evidence Bank`);
  for (const w of draft.warnings.slice(0, 4)) out.note(`  ${out.yellow("!")} ${w}`);
  out.note("");
}

async function initNonInteractive(ctx: Ctx, opts: InitOpts): Promise<InitResult> {
  const repo = await ctx.repo();
  const patch = flagPatch(opts);
  if (patch.unknownSkills.length) ctx.out.warn(`kept as typed (not in the skills dictionary): ${patch.unknownSkills.join(", ")}`);
  if (opts.sample) {
    if (opts.resume) throw usage("--sample and --resume are exclusive: the sample is a fictional persona.");
    await loadSampleProfile(repo, ctx.tenantId);
    const p = await loadProfile(repo, ctx.tenantId);
    const preset = opts.preset ?? suggestPreset({ ...p.prefs, ...patch.prefs }).id;
    const r = await finishOnboarding(repo, ctx.files(), ctx.tenantId, { ...patch, discoveryPreset: preset });
    return { evidenceAdded: (await repo.listEvidence(ctx.tenantId)).length, readiness: r.readiness, preset };
  }
  const imported = await importFrom(ctx, opts);
  if (imported && !ctx.out.json) printDraft(ctx, imported.draft);
  const draftContact = imported?.draft.contact ?? {};
  const home = patch.prefs.homeCountry ?? homeFromDraft(imported?.draft ?? null);
  const prefs: Partial<ProfilePrefs> = { ...patch.prefs };
  if (home) prefs.homeCountry = home;
  if (!prefs.remoteGeoOk && home) prefs.remoteGeoOk = remoteGeosForCountry(home);
  if (!prefs.targetArchetypes && imported?.draft.archetypes.length) prefs.targetArchetypes = imported.draft.archetypes.filter((a) => a !== "other");
  const current = await loadProfile(repo, ctx.tenantId);
  const preset = opts.preset ?? suggestPreset({ ...current.prefs, ...prefs }).id;
  const r = await finishOnboarding(repo, ctx.files(), ctx.tenantId, {
    draft: imported?.draft ?? null,
    file: imported?.file ?? null,
    mode: "replace",
    contact: { ...stripEmpty(draftContact), ...patch.contact },
    prefs,
    yoe: patch.yoe,
    levelBand: patch.levelBand,
    stackProfile: patch.stackProfile,
    discoveryPreset: preset,
  });
  return { evidenceAdded: r.evidenceAdded, readiness: r.readiness, preset };
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== "resumePath" && typeof v === "string" && v.trim())) as Partial<T>;
}

async function initInteractive(ctx: Ctx, opts: InitOpts): Promise<InitResult> {
  const out = ctx.out;
  const repo = await ctx.repo();
  const current = await loadProfile(repo, ctx.tenantId);
  out.note(out.bold("JobFlow setup") + out.dim(" — Enter keeps the value in [brackets]. Everything stays on this machine."));
  if (isOnboarded(current) && !opts.force) {
    out.note(`You're already set up as ${out.bold(fullName(current) || "(unnamed)")}.`);
    if (!(await ctx.confirm("Run setup again (your answers replace the current ones)?", false))) {
      const evidence = await repo.listEvidence(ctx.tenantId);
      const { profileReadiness } = await import("@jobflow/pipeline");
      return { evidenceAdded: 0, readiness: profileReadiness(current, evidence.length), preset: (await repo.getConfig(ctx.tenantId))?.discoveryPreset ?? "india" };
    }
  }

  // ── 1. résumé ──
  let imported: { draft: ResumeDraft; file: StoredFile | null } | null = null;
  if (opts.sample) return initNonInteractive(ctx, { ...opts, yes: true });
  for (;;) {
    const src = opts.resume ?? (await ctx.ask("Résumé file path (pdf/docx/tex/md/txt/json) — or 'paste', 'sample', Enter to skip:"));
    opts.resume = undefined;
    if (!src) break;
    if (src === "sample") return initNonInteractive(ctx, { ...opts, sample: true, yes: true });
    try {
      if (src === "paste") {
        out.note(out.dim("Paste your résumé text, then a line with just a single '.' to finish:"));
        const lines: string[] = [];
        for (;;) {
          const l = await ctx.readLine();
          if (l == null || l.trim() === ".") break;
          lines.push(l);
        }
        const r = await importResume(repo, ctx.files(), ctx.tenantId, { text: lines.join("\n"), assist: opts.assist });
        imported = { draft: r.draft, file: r.file };
      } else {
        imported = await importFrom(ctx, { ...opts, resume: src });
      }
      break;
    } catch (e) {
      out.warn((e as Error).message);
    }
  }
  if (imported) printDraft(ctx, imported.draft);

  // ── 2. confirm the key fields ──
  const d = imported?.draft;
  const dc = { ...current.prefs.contact, ...stripEmpty(d?.contact ?? {}) };
  const patch = flagPatch(opts);
  const name = await ctx.ask("Your name:", patch.contact.firstName != null ? `${patch.contact.firstName} ${patch.contact.lastName ?? ""}`.trim() : `${dc.firstName} ${dc.lastName}`.trim());
  const [first = "", ...rest] = name.split(/\s+/);
  const contact: Partial<Contact> = {
    firstName: first,
    lastName: rest.join(" "),
    email: await ctx.ask("Email:", patch.contact.email ?? dc.email),
    phone: await ctx.ask("Phone (optional):", patch.contact.phone ?? dc.phone),
    linkedin: await ctx.ask("LinkedIn URL (optional):", patch.contact.linkedin ?? dc.linkedin),
    github: await ctx.ask("GitHub URL (optional):", patch.contact.github ?? dc.github),
  };
  const skillDefault = (patch.stackProfile ?? (d?.skills.canonical.length ? d.skills.canonical : current.prefs.stackProfile)).join(", ");
  const sk = parseSkills(await ctx.ask("Skills (comma-separated):", skillDefault));
  if (sk.unknown.length) out.note(out.dim(`  kept as typed: ${sk.unknown.join(", ")}`));
  const yoe = await askValid(ctx, "Years of experience:", String(patch.yoe ?? d?.yoe.value ?? current.yoe), yoeValue);
  const level = await askValid(ctx, `Level (${LevelBand.options.join("/")}):`, patch.levelBand ?? d?.levelBand.value ?? current.levelBand, levelBand);

  // ── 3. preferences ──
  out.note("");
  out.note(out.bold("Where and what you want"));
  const home = await askValid(ctx, "Home country (ISO-2, e.g. US, IN, DE):", patch.prefs.homeCountry ?? (current.prefs.homeCountry || homeFromDraft(d ?? null)), (v) => countryCode(v, "home"));
  const markets = await askValid(ctx, "Markets to search (ISO-2 list):", (patch.prefs.markets ?? (current.prefs.markets.length ? current.prefs.markets : [home])).join(","), countryList);
  const geos = await askValid(
    ctx,
    "Remote regions you can work in (worldwide,us_only,eu_only,us_eu,india_ok,apac_ok):",
    (patch.prefs.remoteGeoOk ?? remoteGeosForCountry(home)).join(","),
    remoteGeos,
  );
  const relocate = await askValid(ctx, "Open to relocating? (y/n)", (patch.prefs.relocate ?? current.prefs.relocate) ? "y" : "n", yesNo);
  const floorDefault = patch.prefs.salaryFloor ? `${patch.prefs.salaryFloor} ${patch.prefs.currency}` : current.prefs.salaryFloor ? `${current.prefs.salaryFloor} ${current.prefs.currency}` : "";
  const floorAns = await ctx.ask('Salary floor, e.g. "150000 USD" (Enter for none):', floorDefault);
  const floor = floorAns ? money(floorAns) : null;
  const rolesDefault = (patch.prefs.targetArchetypes ?? (current.prefs.targetArchetypes.length ? current.prefs.targetArchetypes : (d?.archetypes ?? []).filter((a) => a !== "other"))).join(",");
  const roles = await askValid(ctx, `Target role types (${RoleArchetype.options.filter((r) => r !== "other").join(",")}):`, rolesDefault, (v) => (v ? archetypes(v) : []));
  const locs = await ctx.ask("Preferred locations, most preferred first (e.g. Remote, Berlin):", patch.prefs.locationWeights?.map((l) => l.label).join(", ") ?? current.prefs.locationWeights.map((l) => l.label).join(", "));

  const prefs: Partial<ProfilePrefs> = {
    homeCountry: home,
    markets,
    remoteGeoOk: geos,
    relocate,
    salaryFloor: floor?.amount ?? 0,
    currency: floor?.currency ?? (current.prefs.currency || "USD"),
    targetArchetypes: roles,
    locationWeights: locationWeights(locs),
  };

  // ── 4. discovery preset ──
  const suggested = opts.preset ?? suggestPreset({ ...current.prefs, ...prefs }).id;
  out.note("");
  out.note(out.bold("Discovery preset") + out.dim(" — which boards and feeds `jobflow sync` polls (add your own later with `jobflow discovery`)"));
  for (const p of listPresets()) out.note(`  ${p.id.padEnd(14)} ${out.dim(p.description)}`);
  const preset = await askValid(ctx, "Preset:", suggested, (v) => {
    if (!listPresets().some((p) => p.id === v)) throw usage(`unknown preset "${v}"`);
    return v;
  });

  const r = await finishOnboarding(repo, ctx.files(), ctx.tenantId, {
    draft: imported?.draft ?? null,
    file: imported?.file ?? null,
    mode: "replace",
    contact,
    prefs,
    yoe,
    levelBand: level,
    stackProfile: sk.skills,
    discoveryPreset: preset,
  });
  return { evidenceAdded: r.evidenceAdded, readiness: r.readiness, preset };
}

/** ask until the answer parses (a bad answer re-asks instead of aborting the wizard) */
async function askValid<T>(ctx: Ctx, q: string, def: string, parse: (v: string) => T): Promise<T> {
  for (let i = 0; ; i++) {
    const a = await ctx.ask(q, def);
    try {
      return parse(a);
    } catch (e) {
      if (i >= 4) throw e;
      ctx.out.warn((e as Error).message);
    }
  }
}
