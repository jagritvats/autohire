import type { Repository } from "./repository.js";
import { InMemoryRepository } from "./memory.js";

/**
 * Compose the repository everything shares. DATABASE_URL present → durable Postgres
 * (Supabase or any Postgres); otherwise the in-memory repo (dev/CI, zero infra).
 * One line to swap — callers depend only on the `Repository` interface.
 */
export async function createRepository(): Promise<Repository> {
  if (process.env.DATABASE_URL) {
    const { PgRepository } = await import("./postgres.js");
    return new PgRepository();
  }
  return new InMemoryRepository();
}

export function isDurable(): boolean {
  return !!process.env.DATABASE_URL;
}
