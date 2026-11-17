import { normCompany, type Posting } from "@jobflow/core";
import type { NewPosting, Repository } from "@jobflow/db";
import type { Ctx } from "./context.js";
import { CliError, EXIT, notFound, usage } from "./errors.js";

/**
 * Posting references: a full id, a unique id prefix (≥ 4 chars), or a row number from the
 * last `feed` / `search` / `track list` listing — `#3`, or plain `3` (an unquoted `#3` is a
 * comment in most shells). A search result that isn't in your corpus yet is saved into it
 * the moment you reference it, so `search → tailor 2 → apply 2` just works.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedPosting {
  posting: Posting;
  /** it was a transient search result and has just been saved to your corpus */
  kept: boolean;
}

export async function resolvePosting(ctx: Ctx, ref: string): Promise<ResolvedPosting> {
  const r = ref.trim();
  if (!r) throw usage("Give a posting: an id, an id prefix, or a row number like 3 from the last listing.");
  const repo = await ctx.repo();
  const state = ctx.readState();
  const transient = state.transient ?? {};

  let id: string | null = null;
  const row = r.match(/^#?(\d{1,3})$/);
  if (row) {
    const n = Number(row[1]);
    const ids = state.listing?.ids ?? [];
    if (!ids.length) throw notFound(`No listing to take #${n} from.`, "Run `jobflow feed` or `jobflow search …` first, then refer to a row by its number.");
    id = ids[n - 1] ?? null;
    if (!id) throw notFound(`The last ${state.listing!.kind} listing has ${ids.length} row(s) — there's no #${n}.`);
  } else if (UUID.test(r)) {
    id = r.toLowerCase();
  } else if (/^[0-9a-f-]{4,}$/i.test(r)) {
    id = await resolvePrefix(repo, ctx.tenantId, r.toLowerCase(), [...(state.listing?.ids ?? []), ...Object.keys(transient)]);
  } else {
    throw usage(`"${r}" isn't a posting reference.`, "Use a row number from the last listing (e.g. 3), an id, or an id prefix.");
  }

  const stored = await repo.getPosting(id);
  if (stored) return { posting: stored, kept: false };
  const t = transient[id];
  if (t) {
    const posting = await keepPosting(repo, t);
    // later refs to the same row resolve to the stored copy
    ctx.writeState({
      listing: state.listing ? { ...state.listing, ids: state.listing.ids.map((x) => (x === id ? posting.id : x)) } : state.listing,
      transient: Object.fromEntries(Object.entries(transient).filter(([k]) => k !== id)),
    });
    return { posting, kept: true };
  }
  throw notFound(`No posting ${r} in your corpus.`, "It may have expired; run `jobflow sync` or search again.");
}

async function resolvePrefix(repo: Repository, tenantId: string, prefix: string, extra: string[]): Promise<string> {
  const ids = new Set<string>(extra.filter((x) => x.startsWith(prefix)));
  for (const p of await repo.listActivePostings()) if (p.id.startsWith(prefix)) ids.add(p.id);
  for (const a of await repo.listApplications(tenantId)) if (a.postingId.startsWith(prefix)) ids.add(a.postingId);
  if (ids.size === 1) return [...ids][0]!;
  if (ids.size === 0) throw notFound(`No posting id starts with "${prefix}".`);
  throw new CliError(`"${prefix}" matches ${ids.size} postings — use more characters.`, EXIT.usage);
}

/**
 * Save a transient search result into the corpus, exactly as ingest would (idempotent upsert
 * on (atsType, atsJobId), invariant #5). The company joins the registry as a discovered shell.
 */
async function keepPosting(repo: Repository, p: Posting): Promise<Posting> {
  const company = await repo.upsertCompany({
    name: p.companyName,
    nameNorm: normCompany(p.companyName),
    atsType: p.atsType,
    tags: ["discovered", p.source],
  });
  const {
    id: _id,
    firstSeen: _f,
    lastSeen: _l,
    isActive: _a,
    repostCount: _r,
    canonicalId: _c,
    status: _s,
    invalidReason: _ir,
    invalidatedAt: _ia,
    ...rest
  } = p;
  const np: NewPosting = { ...rest, companyId: company.id, companyName: company.name };
  return repo.upsertPosting(np);
}
