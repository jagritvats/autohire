#!/usr/bin/env node
// Capture REAL MCP tool output for the "Use JobFlow from Claude Code" guide: start
// `jobflow mcp` exactly as an MCP client would (stdio), in demo mode on the throwaway home
// from capture-cli.mjs (the FICTIONAL sample persona + fictional boards), and call the tools
// the illustrated conversation shows. Writes $VIDEO_OUT/mcp/<step>.json.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, ROOT, ensureDir } from "./lib/util.mjs";

const require = createRequire(join(ROOT, "packages", "mcp", "package.json"));
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);

const HOME = join(OUT, "cli-home");
const dir = ensureDir(join(OUT, "mcp"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "apps", "cli", "bin", "jobflow.mjs"), "mcp"],
  env: { PATH: process.env.PATH, HOME, JOBFLOW_DEMO_DATA: "1", LLM_PROVIDER: "echo" },
  stderr: "inherit",
});
const client = new Client({ name: "jobflow-video-capture", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
writeFileSync(join(dir, "tools.json"), JSON.stringify(tools.tools.map((t) => ({ name: t.name, description: t.description })), null, 1));

async function call(step, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const out = { step, tool: name, args, text, structured: r.structuredContent ?? null, isError: !!r.isError };
  writeFileSync(join(dir, `${step}.json`), JSON.stringify(out, null, 1));
  console.log(`✓ ${step} (${name}) ${text.length} chars${r.isError ? " — ERROR" : ""}`);
  return out;
}

await call("status", "jobflow_status", {});
const search = await call("search", "search_jobs", { query: "backend engineer --remote --posted 14d" });
// the best result you haven't tracked yet (the conversation reads one new role)
const results = search.structured?.results ?? [];
const top = results.find((r) => !r.applied) ?? results[0];
const id = top?.id ?? top?.jobId;
if (!id) throw new Error("no search result id: " + JSON.stringify(search.structured).slice(0, 400));
await call("job", "get_job", { id });
await call("prepare", "prepare_application", { id });
await client.close();
