import { join } from "node:path";
import type { Command } from "commander";
import {
  assertCanFill,
  assertNeverSubmits,
  fillPlanOnPage,
  hasDedicatedFieldMap,
  launchUserContext,
  readFlags,
  type AutomationFlags,
} from "@jobflow/autofill";
import { buildApplyPlan, trackApplication, type ApplyPlan } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { CliError, EXIT, needsSetup } from "../errors.js";
import { PLAYWRIGHT_INSTALL_HINT, openUrl, playwrightStatus } from "../browser.js";
import { resolvePosting } from "../refs.js";

/**
 * `jobflow apply <ref>` — assisted apply, up to the review gate (invariant #2):
 *   (default) print the dry-run fill plan and mark the posting "ready" in your tracker;
 *   --open    open the form in your default browser;
 *   --fill    type the plan into the form in a local browser, then STOP for you to review
 *             and submit yourself.
 * There is no submit option and no code path that submits. An application is marked
 * "applied" only when you say so.
 */

const FIX: Record<string, string> = {
  email: "jobflow profile set email you@example.com",
  name: 'jobflow profile set name "First Last"',
  resume: "jobflow profile import ./resume.pdf   (or: jobflow profile set resume-path ./resume.pdf)",
  applyUrl: "this posting has no apply link — open the listing and apply there",
  resumeFormat:
    "forms want a PDF/Word file, not your .md/.tex/.txt source — `jobflow tailor <ref> --kind resume-md --pdf`, or `jobflow profile set resume-path ./resume.pdf`",
};

export function register(program: Command, ctx: Ctx): void {
  program
    .command("apply")
    .description("prepare an application: see what would be filled, open the form, or pre-fill it for you to review and submit")
    .argument("<ref>", "row number from the last listing, posting id, or id prefix")
    .option("--open", "open the application form in your default browser")
    .option("--fill", "pre-fill the form in a local browser (Playwright), then stop for you to review and submit")
    .option("--browser-profile <dir>", "browser profile for --fill (default <data dir>/browser-profile; keeps your logins)")
    .addHelpText(
      "after",
      `
JobFlow never submits an application. --fill stops at the review screen; you check
every field and press submit yourself. Then record it: jobflow track status <ref> applied`,
    )
    .action(async (ref: string, o: { open?: boolean; fill?: boolean; browserProfile?: string }) => {
      const repo = await ctx.repo();
      const { posting, kept } = await resolvePosting(ctx, ref);
      if (kept) ctx.out.hint("(saved this search result to your corpus)");
      const ap = await buildApplyPlan(repo, ctx.files(), ctx.tenantId, posting.id);

      // the tracker: preparing an application makes it "ready" — never "applied"
      const status = ap.application?.status;
      const app =
        !status || status === "saved" || status === "drafting"
          ? await trackApplication(repo, ctx.tenantId, posting.id, { status: "ready", nextAction: ap.application?.nextAction ?? "review & submit" })
          : ap.application!;

      ref = ref.replace(/^#/, ""); // hints must be copy-pasteable (an unquoted #3 is a shell comment)
      if (o.fill) return fill(ctx, ap, ref, o.browserProfile);

      let opened = false;
      if (o.open) {
        if (!ap.applyUrl) throw new CliError("This posting has no apply link.", EXIT.error);
        await openUrl(ap.applyUrl).then(
          () => (opened = true),
          (e: Error) => ctx.out.warn(`couldn't open a browser (${e.message}) — open this yourself: ${ap.applyUrl}`),
        );
      }

      ctx.out.emit(
        {
          posting: { id: posting.id, title: posting.title, company: posting.companyName },
          applyUrl: ap.applyUrl,
          resume: ap.resume,
          coverLetter: ap.coverLetter,
          missing: ap.missing,
          plan: ap.plan,
          tracker: app.status,
          opened,
          submitted: false,
        },
        () => printPlan(ctx, ap, ref, app.status, opened),
      );
    });
}

function printPlan(ctx: Ctx, ap: ApplyPlan, ref: string, status: string, opened: boolean): void {
  const out = ctx.out;
  const kv = (k: string, v: string) => out.line(`  ${out.dim(k.padEnd(13))} ${v}`);
  out.line(`${out.bold("Apply")} · ${ap.posting.title} · ${ap.posting.companyName}`);
  kv("form", ap.applyUrl ? `${ap.applyUrl}${ap.plan && !hasDedicatedFieldMap(ap.plan.ats) ? out.dim("  (generic field map)") : ""}` : out.yellow("no apply link"));
  kv(
    "résumé",
    ap.resume.path
      ? `${ap.resume.path} ${out.dim(ap.resume.source === "tailored" ? "(tailored for this role)" : "(your base résumé)")}${ap.resume.exists ? "" : out.red("  — file not found")}`
      : out.yellow("none to attach"),
  );
  kv("cover letter", ap.coverLetter ? "saved for this role" : out.dim(`none — jobflow tailor ${ref} --kind cover`));
  const answers = Object.keys(ap.applicant.answers ?? {});
  if (answers.length) kv("answers", answers.join(" · "));
  kv("tracker", status);
  out.line();
  if (ap.plan) {
    // what would be typed where — the dry run IS the plan, nothing touched a page
    for (const l of ap.dryRun.split("\n")) out.line(`  ${l.startsWith("DRY RUN") ? out.dim(l) : l}`);
  } else out.line(`  ${ap.dryRun}`);
  if (ap.missing.length) {
    out.line();
    out.line(out.yellow("Fix before filling:"));
    for (const m of ap.missing) out.line(`  ${m.padEnd(9)} → ${FIX[m] ?? m}`);
  }
  out.line();
  if (opened) out.ok("Opened the form in your browser.");
  out.hint(`next: jobflow apply ${ref} --open (apply yourself) · jobflow apply ${ref} --fill (pre-fill, you review + submit)`);
  out.hint(`after you submit: jobflow track status ${ref} applied`);
}

/** The effective flags: the env is a hard floor when it says off; `config set automation.fill on` turns it on. */
function effectiveFlags(ctx: Ctx, cfg: { browser: string; mode: string; rate: "human" | "fast" } | undefined): AutomationFlags {
  const env = readFlags(ctx.io.env);
  const envOff = ctx.io.env.JOBFLOW_BROWSER === "off";
  return {
    browser: !envOff && (env.browser === "on" || cfg?.browser === "on") ? "on" : "off",
    mode: env.mode === "fill" || cfg?.mode === "fill" ? "fill" : "capture",
    autosubmit: false,
    rate: ctx.io.env.JOBFLOW_RATE ? env.rate : cfg?.rate ?? "human",
    tier3Sources: [],
  };
}

async function fill(ctx: Ctx, ap: ApplyPlan, ref: string, browserProfile?: string): Promise<void> {
  const out = ctx.out;
  const repo = await ctx.repo();
  if (!ap.plan) throw new CliError("This posting has no apply link to fill.", EXIT.error);
  if (ap.missing.includes("email")) throw needsSetup("No contact email in your profile — the form needs one.", FIX.email);

  const cfg = (await repo.getConfig(ctx.tenantId))?.automationFlags;
  const flags = effectiveFlags(ctx, cfg);
  try {
    assertCanFill(flags);
  } catch {
    throw needsSetup(
      ctx.io.env.JOBFLOW_BROWSER === "off" ? "Form filling is switched off by JOBFLOW_BROWSER=off." : "Form filling is off.",
      "Turn it on once with: jobflow config set automation.fill on   (it only ever fills — you always submit)",
    );
  }
  assertNeverSubmits(flags); // gate 4 — immovable

  const pw = await playwrightStatus();
  if (!pw.installed) throw needsSetup("--fill needs Playwright, which isn't installed.", `Install it: ${PLAYWRIGHT_INSTALL_HINT}`);
  if (!pw.chromium) throw needsSetup("Playwright is installed but its Chromium isn't.", "Install it: npx playwright install chromium");

  const userDataDir = browserProfile ? ctx.userPath(browserProfile) : ctx.io.env.JOBFLOW_BROWSER_PROFILE?.trim() || join(ctx.dataDir, "browser-profile");
  for (const m of ap.missing.filter((x) => x !== "email")) out.warn(`missing ${m} — ${FIX[m]}`);
  const spin = out.spinner(`Opening ${ap.applyUrl} in a local browser and filling it (human-paced)`);
  const context = await launchUserContext({ userDataDir, headless: false }).catch((e: Error) => {
    spin.stop();
    throw new CliError(`Couldn't start the browser: ${e.message}`, EXIT.error, "Is a display available? Try `jobflow apply --open` instead.");
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const report = await fillPlanOnPage(page, ap.plan, { flags }).finally(() => spin.stop());
    out.emit({ ...report, submitted: false }, () => {
      out.ok(`Filled ${report.filled.length} field(s)${report.answersMatched.length ? ` + ${report.answersMatched.length} answer(s)` : ""}.`);
      if (report.skippedNoField.length) out.line(out.dim(`  not found on the page: ${report.skippedNoField.join(", ")}`));
      if (ap.plan!.unfilled.length) out.line(out.dim(`  no value to fill: ${ap.plan!.unfilled.join(", ")}`));
    });
    out.note("");
    out.note(out.bold(out.yellow("STOPPED AT REVIEW — JobFlow does not submit.")));
    out.note("Check every field in the browser, fix anything wrong, attach what's missing, and press submit YOURSELF.");
    // keep the browser open until the user is done (closing the CLI would close it)
    await Promise.race([ctx.readLine(out.dim("Press Enter here when you're done (this closes the browser)… ")), browserClosed(context)]);
    const submitted = ctx.io.stdinIsTTY ? await ctx.confirm("Did you submit the application?", false) : false;
    if (submitted) {
      await trackApplication(repo, ctx.tenantId, ap.posting.id, { status: "applied", appliedVia: "jobflow apply --fill", nextAction: null });
      out.note(`${out.green("✓")} Marked as applied. Track replies with: jobflow track next ${ref} "follow up" --due <date>`);
    } else out.note(out.dim(`Left as "ready". When you submit: jobflow track status ${ref} applied`));
  } finally {
    await context.close().catch(() => {});
  }
}

/** resolves when the user closes the browser window (no pages left) */
function browserClosed(context: { pages(): unknown[] }): Promise<void> {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      let n = 1;
      try {
        n = context.pages().length;
      } catch {
        n = 0;
      }
      if (n === 0) {
        clearInterval(t);
        resolve();
      }
    }, 1000);
    t.unref?.();
  });
}
