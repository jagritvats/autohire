// The built web app in demo mode (an offline, FICTIONAL corpus + the fictional sample
// candidate, in memory), on VIDEO_PORT (default 3407). It runs in its own process group so
// stopping it also stops next-server; a restart gives a clean demo state.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BASE, PORT, ROOT, sleep } from "./util.mjs";

let server = null;

export async function startServer(extraEnv = {}) {
  await stopServer();
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: join(ROOT, "apps", "web"),
    env: {
      ...process.env,
      JOBFLOW_DEMO_DATA: "1",
      JOBFLOW_STORE: "memory",
      JOBFLOW_AUTH: "none",
      LLM_PROVIDER: "echo",
      DATABASE_URL: "",
      NODE_ENV: "production",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  server.stderr.on("data", (d) => {
    const s = String(d);
    if (!/ExperimentalWarning|punycode/.test(s)) process.stderr.write(`  [web] ${s}`);
  });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.ok) {
        // warm the pages (first render compiles nothing in production, but seeds the demo data)
        await fetch(`${BASE}/`).catch(() => {});
        return;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error(`the web app didn't start on ${BASE}`);
}

export async function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server = null;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await sleep(250);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await stopServer();
    process.exit(130);
  });
}
process.on("exit", () => {
  if (server) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
});
