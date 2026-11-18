import { looksLikeAgency, parseLocation, type ParsedLocation, type Posting, type SourceKind } from "@jobflow/core";

/**
 * Re-derive the normalized location + agency flag of STORED postings after a parser fix,
 * the way `reparseStatedSalaries` does for pay: no re-poll, idempotent (a second run
 * changes nothing).
 *
 * - Location re-parses exactly from the posting's own `locationRaw` (+ its JD). A row
 *   stored before `locationRaw` was kept is left as it is; its board's next poll re-parses
 *   it.
 * - `postedByAgency`: sources that flag intermediaries themselves (Naukri) keep their
 *   stored answer; every other source gets `looksLikeAgency` on its name + JD — the same
 *   rule `normalizePosting` applies at ingest.
 */

/** sources whose adapter sets `postedByAgency` from the source's own field. */
const SOURCE_AGENCY_FLAG: ReadonlySet<SourceKind> = new Set<SourceKind>(["naukri"]);

export interface RenormalizedFields {
  location: ParsedLocation;
  postedByAgency: boolean;
}

/** what the re-normalize pass needs from a repository. */
export interface RenormalizeStore {
  listActivePostings(): Promise<Posting[]>;
  /** rewrite a stored posting's derived location + agency flag */
  updatePostingNormalized(id: string, patch: RenormalizedFields): Promise<void>;
}

export interface RenormalizeStats {
  scanned: number;
  changed: number;
  /** postings whose parsed location changed */
  locations: number;
  /** postings that now name 2+ countries (and named fewer before) */
  multiCountry: number;
  /** postings with no country before that have one now */
  placed: number;
  /** postings newly flagged as posted by an agency / consultancy */
  agencyFlagged: number;
  /** postings whose agency flag was cleared */
  agencyCleared: number;
  /** postings stored without their location text (location left as is) */
  noRaw: number;
}

function sameLocation(a: ParsedLocation, b: ParsedLocation): boolean {
  const ca = a.countries ?? [];
  const cb = b.countries ?? [];
  return (
    a.mode === b.mode && a.city === b.city && a.country === b.country && a.timezone === b.timezone &&
    a.remoteGeo === b.remoteGeo && a.sponsorship === b.sponsorship && a.confidence === b.confidence &&
    ca.length === cb.length && ca.every((c, i) => c === cb[i])
  );
}

/** the re-derived fields for one stored posting, or null when nothing changes. */
export function renormalizePosting(p: Posting): RenormalizedFields | null {
  const raw = typeof p.locationRaw === "string" && p.locationRaw.trim() ? p.locationRaw : null;
  const location = raw ? parseLocation(raw, p.jdText) : p.location;
  const stored = p.postedByAgency ?? false;
  const postedByAgency = SOURCE_AGENCY_FLAG.has(p.source) ? stored : looksLikeAgency(p);
  if (sameLocation(location, p.location) && postedByAgency === stored) return null;
  return { location, postedByAgency };
}

export async function renormalizePostings(store: RenormalizeStore): Promise<RenormalizeStats> {
  const stats: RenormalizeStats = { scanned: 0, changed: 0, locations: 0, multiCountry: 0, placed: 0, agencyFlagged: 0, agencyCleared: 0, noRaw: 0 };
  for (const p of await store.listActivePostings()) {
    stats.scanned++;
    if (!(typeof p.locationRaw === "string" && p.locationRaw.trim())) stats.noRaw++;
    // read before the write: a repo may hand back live objects
    const before = { location: p.location, agency: p.postedByAgency ?? false };
    const next = renormalizePosting(p);
    if (!next) continue;
    await store.updatePostingNormalized(p.id, next);
    stats.changed++;
    if (!sameLocation(next.location, before.location)) {
      stats.locations++;
      if ((next.location.countries?.length ?? 0) >= 2 && (before.location.countries?.length ?? 0) < 2) stats.multiCountry++;
      if (before.location.country == null && next.location.country != null) stats.placed++;
    }
    if (next.postedByAgency && !before.agency) stats.agencyFlagged++;
    if (!next.postedByAgency && before.agency) stats.agencyCleared++;
  }
  return stats;
}
