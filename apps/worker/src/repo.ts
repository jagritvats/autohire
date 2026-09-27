import { createRepository, type Repository } from "@jobflow/db";

/**
 * The repository the worker uses. DATABASE_URL present → durable Postgres (Supabase
 * or VPS); otherwise in-memory (dev/CI). Single source of truth via the db factory.
 *
 * One instance per process: the one-shot `all` path runs discover → poll → rank → enrich
 * as separate stages, and in memory a fresh repository per stage meant poll saw none of
 * discover's companies and rank saw none of poll's postings — a green run that did nothing.
 * (With Postgres it also means one connection pool, not one per stage.)
 */
let shared: Promise<Repository> | null = null;

export function makeRepository(): Promise<Repository> {
  shared ??= createRepository();
  return shared;
}
