#!/usr/bin/env node
import { runCli } from "./program.js";

/**
 * `jobflow` entry: run one command and exit with its code
 * (0 ok · 1 error · 2 usage · 3 not found · 4 needs setup).
 */
const code = await runCli(process.argv.slice(2));
// exit once stdout has drained (piped --json output) — don't wait on idle keep-alive
// sockets from the live job APIs
process.exitCode = code;
process.stdout.write("", () => process.exit(code));
