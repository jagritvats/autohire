import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createRepository, ensurePrivateDir, loadRootEnv } from "@jobflow/db";
import { DEFAULT_IDLE_MS, createLocalStore, serveStdio } from "@jobflow/mcp";
import type { Ctx } from "../context.js";
import { usage } from "../errors.js";

/**
 * `jobflow mcp` — JobFlow as an MCP server on stdio, for AI agents (Claude Code, Claude
 * Desktop, any MCP client): search, the ranked feed, job detail, the tracker, the apply
 * plan and grounded drafting, on the same local data as the CLI and the web app.
 *
 * stdout is the protocol channel — this command never prints there. The PGlite store is
 * opened per tool call and closed after a short idle period, so `jobflow …` and
 * `jobflow serve` keep working while the agent's session stays open; a busy data dir is a
 * friendly tool error. Like every command, it never submits an application (invariant #2).
 */
export function register(program: Command, ctx: Ctx): void {
  program
    .command("mcp")
    .description("serve JobFlow to AI agents over MCP (stdio) — Claude Code, Claude Desktop, any MCP client")
    .option("--idle <seconds>", "release the local database after this many idle seconds", String(DEFAULT_IDLE_MS / 1000))
    .addHelpText(
      "after",
      `
Speaks the Model Context Protocol on stdin/stdout; an MCP client starts it for you:
  claude mcp add jobflow -- pnpm -s --dir /path/to/jobflow jobflow mcp
Tools: jobflow_status, search_jobs, list_jobs, get_job, saved searches, track_application,
list_applications, prepare_application (a dry-run plan), draft_document, sync_sources.
Nothing it exposes submits or fills a form. Guide: docs/guides/ai-agents-mcp.md`,
    )
    .action(async (o: { idle: string }) => {
      const secs = Number(o.idle);
      if (!Number.isFinite(secs) || secs < 0) throw usage(`--idle must be a number of seconds (got "${o.idle}")`);
      ctx.loadEnv(); // the data dir + .env (the user's model) for the shared packages
      // an MCP client may start us from any directory (Claude Desktop: `/`): also read the
      // .env of the checkout this command lives in (never overrides what's already set)
      loadRootEnv(fileURLToPath(new URL(".", import.meta.url)));
      const store = ctx.storeKind;
      const dataDir = ctx.dataDir;
      const access = createLocalStore({
        tenantId: ctx.tenantId,
        dataDir,
        // the in-memory store would lose everything on close; Postgres is concurrent anyway
        // but closing idle connections is still polite
        idleMs: store === "memory" ? null : Math.round(secs * 1000),
        open: async () => {
          if (store === "pglite") ensurePrivateDir(dataDir);
          return createRepository({ store, dataDir });
        },
      });
      process.stderr.write(`[jobflow mcp] serving on stdio · store ${store}${store === "pglite" ? ` (${dataDir})` : ""} · opened per call, released after ${secs}s idle\n`);
      await serveStdio({ tenantId: ctx.tenantId, access, files: ctx.files(), dataDir, store }, { version: program.version() });
    });
}
