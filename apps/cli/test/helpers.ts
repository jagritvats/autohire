import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Repository } from "@jobflow/db";
import type { SyncRunner } from "@jobflow/service";
import { runCli } from "../src/program.js";
import type { CliIO } from "../src/output.js";

export interface RunResult {
  code: number;
  out: string;
  err: string;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** a throwaway data dir per test */
export function tempDir(prefix = "jobflow-cli-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run one CLI invocation in-process with captured stdout/stderr and the given stdin. */
export async function run(
  args: string[],
  opts: { dataDir: string; repo?: Repository; stdin?: string; store?: "memory" | "pglite"; sync?: SyncRunner },
): Promise<RunResult> {
  let out = "";
  let err = "";
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.DATABASE_URL;
  delete env.JOBFLOW_STORE;
  delete env.INIT_CWD;
  const io: CliIO = {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    stdin: Readable.from(opts.stdin != null ? [opts.stdin] : []),
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdinIsTTY: false,
    env,
  };
  const argv = ["--data-dir", opts.dataDir, "--store", opts.store ?? "memory", ...args];
  const code = await runCli(argv, { io, repo: opts.repo, sync: opts.sync });
  return {
    code,
    out,
    err,
    json() {
      try {
        return JSON.parse(out);
      } catch {
        throw new Error(`not JSON (exit ${code}):\n${out}\n--- stderr ---\n${err}`);
      }
    },
  };
}

/** A FICTIONAL résumé fixture — nobody real. */
export const SAM_RESUME = [
  "Sam Placeholder",
  "sam@example.com · github.com/sam-placeholder · Austin, TX",
  "",
  "SUMMARY",
  "Backend engineer with 5 years of experience building Go services on Postgres and Kafka.",
  "",
  "EXPERIENCE",
  "Senior Software Engineer, Example Corp — Jan 2021 – Present",
  "- Built a Go ingestion service on Postgres and Kafka handling 10k events/s",
  "- Cut p99 latency of the billing API by 35% by reworking its Postgres indexes",
  "Software Engineer, Placeholder Labs — Jun 2019 – Dec 2020",
  "- Shipped a Python data pipeline on Docker and Kubernetes",
  "",
  "SKILLS",
  "Go, PostgreSQL, Kafka, Python, Docker, Kubernetes, REST",
].join("\n");

export function writeResume(dir: string): string {
  const p = join(dir, "sam-resume.txt");
  writeFileSync(p, SAM_RESUME);
  return p;
}

/** a Remotive-shaped response for the stubbed network */
export function remotiveJobs() {
  return {
    jobs: [
      {
        id: 9101,
        url: "https://remotive.com/remote-jobs/software-dev/senior-backend-engineer-9101",
        title: "Senior Backend Engineer",
        company_name: "Example Systems",
        category: "Software Development",
        candidate_required_location: "Worldwide",
        salary: "",
        description: "<p>We build event pipelines in Go on Postgres and Kafka. Fully remote, worldwide.</p>",
        publication_date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      {
        id: 9102,
        url: "https://remotive.com/remote-jobs/software-dev/platform-engineer-9102",
        title: "Platform Engineer",
        company_name: "Placeholder Cloud",
        category: "Software Development",
        candidate_required_location: "Worldwide",
        salary: "",
        description: "<p>Kubernetes, Terraform, Go. Remote.</p>",
        publication_date: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      },
    ],
  };
}

/** fetch stub: Remotive answers, everything else is a 404 — no live HTTP in tests */
export function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://remotive.com/api/remote-jobs")) {
      return new Response(JSON.stringify(remotiveJobs()), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
