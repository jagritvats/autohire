import type { Posting } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { keepPosting, scoreKept } from "@jobflow/service";

/**
 * Posting references for tools: a full id or a unique id prefix (≥ 4 characters). Results
 * of `search_jobs` that aren't in the corpus are TRANSIENT — remembered here (process
 * memory, bounded) so a follow-up call can use them; a tool that acts on one (track,
 * prepare, draft) keeps it into the corpus first — the same idempotent upsert ingest uses
 * (invariant #5). Searching alone writes nothing.
 */

export class ToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSIENT = 300;

export class TransientResults {
  private m = new Map<string, Posting>();
  remember(postings: Posting[]): void {
    for (const p of postings) {
      this.m.delete(p.id);
      this.m.set(p.id, p);
    }
    while (this.m.size > MAX_TRANSIENT) this.m.delete(this.m.keys().next().value as string);
  }
  get(id: string): Posting | undefined {
    return this.m.get(id);
  }
  ids(): string[] {
    return [...this.m.keys()];
  }
  /** the result was kept: later calls with its search id resolve to the stored posting */
  kept(id: string, storedId: string): void {
    this.m.delete(id);
    this.aliases.set(id, storedId);
  }
  storedIdOf(id: string): string | undefined {
    return this.aliases.get(id);
  }
  private aliases = new Map<string, string>();
}

export interface Resolved {
  posting: Posting;
  /** a search result that isn't in the corpus (yet) */
  transient: boolean;
}

/** id or unique prefix → a stored posting, or a remembered search result (not kept). */
export async function findPosting(repo: Repository, tenantId: string, transient: TransientResults, ref: string): Promise<Resolved> {
  const r = ref.trim().toLowerCase();
  if (!r) throw new ToolError("Give a posting id (or a unique prefix of at least 4 characters).");
  let id: string;
  if (UUID.test(r)) id = r;
  else if (/^[0-9a-f-]{4,}$/.test(r)) {
    const ids = new Set(transient.ids().filter((x) => x.startsWith(r)));
    for (const p of await repo.listActivePostings()) if (p.id.startsWith(r)) ids.add(p.id);
    for (const a of await repo.listApplications(tenantId)) if (a.postingId.startsWith(r)) ids.add(a.postingId);
    if (ids.size === 0) throw new ToolError(`No posting id starts with "${r}".`, "Use an id from list_jobs or search_jobs.");
    if (ids.size > 1) throw new ToolError(`"${r}" matches ${ids.size} postings — use more characters (or the full id).`);
    id = [...ids][0]!;
  } else {
    throw new ToolError(`"${ref}" isn't a posting id.`, "Pass the `id` from list_jobs / search_jobs (a UUID), or a unique prefix of it.");
  }
  id = transient.storedIdOf(id) ?? id;
  const stored = await repo.getPosting(id).catch(() => null);
  if (stored) return { posting: stored, transient: false };
  const t = transient.get(id);
  if (t) return { posting: t, transient: true };
  throw new ToolError(`No posting ${id} in your corpus.`, "It may have expired (boards remove filled roles). Run sync_sources or search again.");
}

/** Like findPosting, but a transient search result is saved into the corpus (and scored). */
export async function keepResolved(repo: Repository, tenantId: string, transient: TransientResults, ref: string): Promise<Resolved & { kept: boolean }> {
  const r = await findPosting(repo, tenantId, transient, ref);
  if (!r.transient) return { ...r, kept: false };
  const posting = await keepPosting(repo, r.posting);
  await scoreKept(repo, tenantId, posting);
  transient.kept(r.posting.id, posting.id);
  return { posting, transient: false, kept: true };
}
