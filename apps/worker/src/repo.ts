import { InMemoryRepository, type Repository } from "@jobflow/db";

/**
 * Compose the repository the worker/web use. DATABASE_URL/SUPABASE_* present →
 * Supabase repo (production, durable, RLS). Otherwise the in-memory repo (dev/CI).
 * Today only in-memory is wired; SupabaseRepository lands in packages/db when you
 * provision the project (schema is already in packages/db/migrations).
 */
export async function makeRepository(): Promise<Repository> {
  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (hasSupabase) {
    // const { SupabaseRepository } = await import("@jobflow/db/supabase");
    // return new SupabaseRepository(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    console.warn("[repo] Supabase env present but SupabaseRepository not yet wired — using memory.");
  }
  return new InMemoryRepository();
}
