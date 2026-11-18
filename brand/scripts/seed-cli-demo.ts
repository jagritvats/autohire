// Seed a scratch PGlite store with the OFFLINE, fully FICTIONAL demo corpus (the same one
// the web app's JOBFLOW_DEMO_DATA=1 mode uses), so the real `jobflow` CLI can be captured for
// brand imagery without live APIs or real listings.
//
//   JOBFLOW_DATA_DIR=<scratch dir> npx tsx brand/scripts/seed-cli-demo.ts
import { createRepository } from "../../packages/db/src/index.js";
import { DEFAULT_TENANT, estimatePostingSalaries } from "../../packages/pipeline/src/index.js";
import { rankTenant, seedDemoCorpus } from "../../packages/service/src/index.js";

const dir = process.env.JOBFLOW_DATA_DIR?.trim();
if (!dir || dir === "/") throw new Error("set JOBFLOW_DATA_DIR to a scratch directory");
const repo = await createRepository({ store: "pglite", dataDir: dir });
if (!(await repo.getTenant(DEFAULT_TENANT).catch(() => null))) await repo.createTenant({ id: DEFAULT_TENANT, name: "default" });
await seedDemoCorpus(repo, DEFAULT_TENANT);
// modeled pay for postings that state none (posting.salaryEstimate; pure math, offline), then
// re-rank so the feed shows "stated" vs "estimate" side by side
await estimatePostingSalaries(repo);
await rankTenant(repo, DEFAULT_TENANT);
await (repo as { close?: () => Promise<void> }).close?.();
console.log(`seeded the fictional demo corpus into ${dir}`);
