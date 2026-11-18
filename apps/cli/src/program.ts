import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import type { Repository } from "@jobflow/db";
import { ProviderError } from "@jobflow/llm";
import { ApplyError, ImportError } from "@jobflow/service";
import { Ctx } from "./context.js";
import { CliError, EXIT, type ExitCode } from "./errors.js";
import { processIO, type CliIO } from "./output.js";
import * as init from "./commands/init.js";
import * as profile from "./commands/profile.js";
import * as evidence from "./commands/evidence.js";
import * as config from "./commands/config.js";
import * as search from "./commands/search.js";
import * as searches from "./commands/searches.js";
import * as discovery from "./commands/discovery.js";
import * as sync from "./commands/sync.js";
import * as feed from "./commands/feed.js";
import * as tailor from "./commands/tailor.js";
import * as apply from "./commands/apply.js";
import * as track from "./commands/track.js";
import * as doctor from "./commands/doctor.js";
import * as serve from "./commands/serve.js";
import * as legacy from "./commands/legacy.js";
import * as status from "./commands/status.js";
import * as mcp from "./commands/mcp.js";
import * as renormalize from "./commands/renormalize.js";

export const VERSION = "0.1.0";

export interface BuildOptions {
  io?: CliIO;
  /** tests: one repository shared across invocations */
  repo?: Repository;
}

/**
 * The whole command tree, built fresh per invocation so tests can run it in-process
 * (`runCli([...], { io, repo })`). Local-first and single-user: no login, no server — the
 * CLI is the default tenant on this machine. There is deliberately no command or option
 * that submits an application (invariant #2).
 */
export function buildProgram(opts: BuildOptions = {}): { program: Command; ctx: Ctx } {
  const io = opts.io ?? processIO();
  const ctx = new Ctx({ io, repo: opts.repo });
  const program = new Command("jobflow");
  program
    .description("JobFlow on your machine — find jobs, get honest matches, tailor, and fill applications up to the review screen.")
    .usage("[options] <command>")
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable JSON on stdout")
    .option("--data-dir <dir>", "where your data lives (default $JOBFLOW_DATA_DIR or ~/.jobflow)")
    .option("--store <kind>", "storage: pglite (default, durable) | memory (throwaway)")
    .option("--no-color", "plain output (also: NO_COLOR=1)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) })
    .showSuggestionAfterError(true)
    .helpCommand(true)
    .addHelpText(
      "after",
      `
The loop:
  jobflow init                         1. who you are (résumé → review → preferences)
  jobflow sync && jobflow feed         2. fetch jobs, see them ranked for you
  jobflow search "backend" --remote    …or search live right now
  jobflow show 1                       3. one job in full: fit, description, apply checklist
  jobflow tailor 1                     4. a résumé/letter grounded in your own material
  jobflow apply 1 --fill               5. pre-fill the form; YOU review and submit
  jobflow track                        6. your applications and follow-ups

Run \`jobflow\` on its own to see where you are and what to do next.
Row numbers (1, 2, …) refer to the last feed/search/track listing. Docs: docs/cli.md`,
    );
  ctx.attach(program);

  status.register(program, ctx);
  init.register(program, ctx);
  profile.register(program, ctx);
  evidence.register(program, ctx);
  config.register(program, ctx);
  search.register(program, ctx);
  searches.register(program, ctx);
  discovery.register(program, ctx);
  sync.register(program, ctx);
  renormalize.register(program, ctx);
  feed.register(program, ctx);
  tailor.register(program, ctx);
  apply.register(program, ctx);
  track.register(program, ctx);
  doctor.register(program, ctx);
  serve.register(program, ctx);
  mcp.register(program, ctx);
  legacy.register(program, ctx);

  program.arguments("[command...]").action((args: string[]) => {
    if (args.length) throw new CliError(`unknown command "${args[0]}"`, EXIT.usage, "Run `jobflow --help` for the list of commands.");
    // no command: where you are + the next step (full help is `jobflow --help`)
    return status.showStatus(ctx);
  });
  return { program, ctx };
}

/** Run one invocation; returns the exit code (never calls process.exit). */
export async function runCli(argv: string[], opts: BuildOptions = {}): Promise<ExitCode> {
  const { program, ctx } = buildProgram(opts);
  try {
    await program.parseAsync(argv, { from: "user" });
    return (ctx.exitCode ?? EXIT.ok) as ExitCode;
  } catch (e) {
    return report(ctx, e);
  } finally {
    await ctx.close();
  }
}

function report(ctx: Ctx, e: unknown): ExitCode {
  const io = ctx.io;
  const out = ctx.out;
  if (e instanceof CommanderError) {
    // commander already printed its message (usage errors) or the help/version text
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help" || e.exitCode === 0) return EXIT.ok;
    return EXIT.usage;
  }
  const line = (msg: string, hint?: string) => {
    io.err(`${out.red("error:")} ${msg}\n`);
    if (hint) io.err(`${out.dim(hint)}\n`);
  };
  if (e instanceof CliError) {
    line(e.message, e.hint);
    return e.code;
  }
  if (e instanceof ZodError) {
    const i = e.issues[0];
    line(`invalid value${i?.path.length ? ` for ${i.path.join(".")}` : ""}: ${i?.message ?? e.message}`);
    return EXIT.usage;
  }
  if (e instanceof ImportError) {
    line(e.message);
    return e.status === 400 ? EXIT.usage : EXIT.error;
  }
  if (e instanceof ApplyError) {
    line(e.message);
    return e.status === 404 ? EXIT.notFound : EXIT.error;
  }
  if (e instanceof ProviderError) {
    const pe = e as ProviderError & { userMessage?: string; status?: number };
    line(pe.userMessage ?? pe.message);
    return pe.status === 404 ? EXIT.notFound : EXIT.error;
  }
  const err = e as Error;
  line(err?.message ?? String(e));
  if (io.env.JOBFLOW_DEBUG) io.err(`${err?.stack ?? ""}\n`);
  return EXIT.error;
}
