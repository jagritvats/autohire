/**
 * Exit codes are part of the CLI's contract (scripts branch on them):
 *   0 ok · 1 error · 2 usage · 3 not found · 4 needs setup (no profile / no model).
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  needsSetup: 4,
  /** stopped by the user (Ctrl-C) — the conventional SIGINT status */
  cancelled: 130,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error the CLI reports as one friendly line (+ an optional hint), never a stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.error,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usage = (msg: string, hint?: string) => new CliError(msg, EXIT.usage, hint);
export const notFound = (msg: string, hint?: string) => new CliError(msg, EXIT.notFound, hint);
export const needsSetup = (msg: string, hint?: string) => new CliError(msg, EXIT.needsSetup, hint);

export const SET_MODEL_HINT = "set a model: jobflow config set llm.provider anthropic && jobflow config set llm.key --stdin";
