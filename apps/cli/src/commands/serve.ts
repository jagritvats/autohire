import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { acquireDataDirLock, ensurePrivateDir, findWorkspaceRoot } from "@jobflow/db";
import type { Ctx } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";

/**
 * `jobflow serve` — the web UI on the SAME local data as the CLI. PGlite is single-writer,
 * so while the server runs it holds the data dir and other `jobflow` commands say so (they
 * read `<dataDir>/server.json` to point you at the running UI) instead of corrupting it.
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("serve")
    .description("open the web UI on your local data (the CLI can't write while it runs)")
    .option("-p, --port <port>", "port", "3000")
    .option("--dev", "run the dev server even if a production build exists")
    .action(async (o: { port: string; dev?: boolean }) => {
      const port = Number(o.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage(`--port must be a port number (got "${o.port}")`);
      const root = findWorkspaceRoot(ctx.cwd) ?? findWorkspaceRoot(new URL("../../../../", import.meta.url).pathname);
      if (!root || !existsSync(join(root, "apps", "web", "package.json"))) {
        throw new CliError("`jobflow serve` runs the web app from the JobFlow repo checkout, which wasn't found.", EXIT.error, "Run it from your clone of the repo (pnpm jobflow serve).");
      }
      const dataDir = ctx.dataDir;
      ensurePrivateDir(dataDir);
      // fail fast (and friendly) if another process holds the data dir
      try {
        acquireDataDirLock(dataDir).release();
      } catch (e) {
        const s = ctx.serverInfo();
        throw new CliError(s ? `jobflow serve is already running at ${s.url} (pid ${s.pid}).` : (e as Error).message, EXIT.error);
      }
      const built = existsSync(join(root, "apps", "web", ".next", "BUILD_ID"));
      const mode = built && !o.dev ? "start" : "dev";
      const url = `http://localhost:${port}`;
      const info = join(dataDir, "server.json");
      const env = { ...process.env, JOBFLOW_STORE: "pglite", JOBFLOW_DATA_DIR: dataDir, PORT: String(port) };
      ctx.out.note(`${ctx.out.bold("JobFlow web")} · ${url} · data: ${dataDir} · next ${mode}`);
      ctx.out.note(ctx.out.dim("While this runs, other jobflow commands can't write your data (single-writer). Ctrl-C to stop."));
      // its own process group, so a stop reaches the whole tree (pnpm → next → next-server),
      // not just pnpm — a surviving next-server would keep the data dir locked
      const posix = process.platform !== "win32";
      const child = spawn("pnpm", ["--silent", "--filter", "@jobflow/web", "exec", "next", mode, "-p", String(port)], {
        cwd: root,
        env,
        stdio: "inherit",
        shell: !posix,
        detached: posix,
      });
      writeFileSync(info, JSON.stringify({ pid: child.pid ?? process.pid, url, port, startedAt: new Date().toISOString() }), { mode: 0o600 });
      const cleanup = () => rmSync(info, { force: true });
      let exited = false;
      const signalTree = (sig: NodeJS.Signals) => {
        if (exited || !child.pid) return;
        try {
          if (posix) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* already gone */
        }
      };
      const stop = (sig: NodeJS.Signals) => () => {
        signalTree(sig);
        // escalate if the tree doesn't go quietly
        setTimeout(() => signalTree("SIGTERM"), 5000).unref();
        setTimeout(() => signalTree("SIGKILL"), 10000).unref();
      };
      const onInt = stop("SIGINT");
      const onTerm = stop("SIGTERM");
      const onExit = () => signalTree("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      process.on("exit", onExit);
      const code = await new Promise<number>((resolve) => {
        child.once("error", (e) => {
          ctx.out.warn(`couldn't start the web app: ${e.message}`);
          resolve(1);
        });
        child.once("exit", (c, sig) => resolve(c ?? (sig ? 130 : 0)));
      });
      // pnpm may exit before its children: make sure nothing of the group outlives us
      signalTree("SIGTERM");
      exited = true;
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("exit", onExit);
      cleanup();
      if (code !== 0 && code !== 130) ctx.exitCode = EXIT.error;
    });
}
