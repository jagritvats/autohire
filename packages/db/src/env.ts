/**
 * `.env` loading for node entrypoints (migrate/worker/cli/agent). The implementation is
 * plain JS in `dotenv.mjs` so apps/web/next.config.mjs runs the very same parser.
 *
 * `loadRootEnv(startDir?)` applies the monorepo-root `.env`, then `$JOBFLOW_DATA_DIR/.env`,
 * never overriding already-set vars; no-op when absent (the in-memory fallback still works).
 */
export { parseDotEnv, loadEnvFile, loadRootEnv, findWorkspaceRoot } from "./dotenv.mjs";
