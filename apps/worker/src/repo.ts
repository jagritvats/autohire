import { createRepository, type Repository } from "@jobflow/db";

/**
 * The repository the worker uses. DATABASE_URL present → durable Postgres (Supabase
 * or VPS); otherwise in-memory (dev/CI). Single source of truth via the db factory.
 */
export async function makeRepository(): Promise<Repository> {
  return createRepository();
}
