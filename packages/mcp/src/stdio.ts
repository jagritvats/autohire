import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJobflowMcpServer, type JobflowMcpContext, type JobflowMcpOptions } from "./server.js";
import type { RepoAccess } from "./store.js";

/**
 * Serve over stdio until the client goes away. stdout IS the protocol channel: anything
 * else printed there corrupts the stream, so console.log/info/debug are routed to stderr
 * for the server's lifetime (a dependency that logs must never break the session).
 */
export async function serveStdio(
  ctx: Omit<JobflowMcpContext, "withRepo"> & { access: RepoAccess },
  opts: JobflowMcpOptions & { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; onReady?: () => void } = {},
): Promise<void> {
  const toErr = (...a: unknown[]) => console.error(...a);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;

  const { access, ...rest } = ctx;
  const server = createJobflowMcpServer({ ...rest, withRepo: (fn) => access.withRepo(fn) }, opts);
  const stdin = (opts.stdin ?? process.stdin) as NodeJS.ReadStream;
  const transport = new StdioServerTransport(stdin, (opts.stdout ?? process.stdout) as NodeJS.WriteStream);

  const done = new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    transport.onclose = finish;
    stdin.once("end", finish);
    stdin.once("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await server.connect(transport);
  opts.onReady?.();
  await done;
  await server.close().catch(() => {});
  await access.close();
}
