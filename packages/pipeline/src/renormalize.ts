import {
  NORMALIZE_VERSION,
  NORMALIZE_VERSION_KEY,
  cleanStoredJd,
  cleanTitle,
  extractSkills,
  looksLikeAgency,
  parseExperience,
  parseLocation,
  parseRequirements,
  parseTitle,
  postingDedupKey,
  titleLevel,
  type ParsedLocation,
  type Posting,
  type SourceKind,
} from "@jobflow/core";
import type { PostingNormalizedPatch } from "@jobflow/db";

/**
 * Re-derive the normalized fields of STORED postings after a parser fix, the way
 * `reparseStatedSalaries` does for pay: no re-poll, idempotent (a second run changes nothing).
 *
 * - Location re-parses exactly from the posting's own `locationRaw` (+ its JD). A row
 *   stored before `locationRaw` was kept is left as it is; its board's next poll re-parses
 *   it.
 * - `postedByAgency`: sources that flag intermediaries themselves (Naukri) keep their
 *   stored answer; every other source gets `looksLikeAgency` on its name + JD — the same
 *   rule `normalizePosting` applies at ingest.
 * - The JD is cleaned the way the adapters clean it today (`cleanStoredJd`: markup and
 *   entities stored before the cleanup existed hid "3+ years" and C++), the title's entities
 *   are decoded (`cleanTitle`), and what they derive is re-read: title family, archetype,
 *   level, skills, requirements, years asked, and the dedup key.
 * - Level / years a SOURCE states (`levelHint` / `experienceHint`, not stored) can't be told
 *   apart from parsed ones, so for the sources that send them a stored value is kept unless
 *   the title / JD now states one with confidence.
 */

/** sources whose adapter sets `postedByAgency` from the source's own field. */
const SOURCE_AGENCY_FLAG: ReadonlySet<SourceKind> = new Set<SourceKind>(["naukri"]);
/** sources whose adapters pass a level bucket of their own (`RawPosting.levelHint`). */
const SOURCE_LEVEL_HINT: ReadonlySet<SourceKind> = new Set<SourceKind>(["smartrecruiters", "bamboohr", "personio", "workable", "recruitee", "himalayas", "jobicy"]);
/** sources whose adapters pass a structured years range (`RawPosting.experienceHint`). */
const SOURCE_EXPERIENCE_HINT: ReadonlySet<SourceKind> = new Set<SourceKind>(["zoho", "personio", "darwinbox", "peerlist", "jsearch", "hirist", "cutshort", "timesjobs", "wellfound", "instahyre"]);

export type RenormalizedFields = PostingNormalizedPatch;

/** what the re-normalize pass needs from a repository. */
export interface RenormalizeStore {
  listActivePostings(): Promise<Posting[]>;
  /** rewrite a stored posting's derived fields */
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
  /** JDs whose stored markup / entities were cleaned */
  jdCleaned: number;
  /** postings whose role type (archetype) changed */
  archetypes: number;
  /** postings whose level band changed */
  levels: number;
  /** postings whose detected skills changed */
  skills: number;
  /** postings whose asked years changed */
  experience: number;
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** the re-derived fields for one stored posting, or null when nothing changes. */
export function renormalizePosting(p: Posting): RenormalizedFields | null {
  const jdText = cleanStoredJd(p.jdText ?? "");
  const title = cleanTitle(p.title) || p.title;
  const raw = typeof p.locationRaw === "string" && p.locationRaw.trim() ? p.locationRaw : null;
  const location = raw ? parseLocation(raw, jdText) : p.location;
  const stored = p.postedByAgency ?? false;
  const postedByAgency = SOURCE_AGENCY_FLAG.has(p.source) ? stored : looksLikeAgency({ companyName: p.companyName, jdText });

  const t = parseTitle(title);
  // a source's own bucket (not stored apart) stands in as the hint `normalizePosting` had
  const levelBand = SOURCE_LEVEL_HINT.has(p.source) ? titleLevel(t, p.levelBand ?? null) : t.levelBand;
  const parsedYears = parseExperience(`${title}\n${jdText}`);
  const storedYears = p.experience ?? { min: null, max: null };
  const experience = SOURCE_EXPERIENCE_HINT.has(p.source) && (storedYears.min != null || storedYears.max != null) ? storedYears : parsedYears;
  const next: RenormalizedFields = {
    location,
    postedByAgency,
    title,
    titleNorm: t.titleNorm,
    roleArchetype: t.roleArchetype,
    levelBand,
    jdText,
    jdSkills: extractSkills(`${title} ${jdText}`),
    requirements: parseRequirements(jdText),
    experience: { min: experience.min, max: experience.max },
    dedupKey: postingDedupKey({ companyName: p.companyName, title, location }),
  };
  const unchanged =
    sameLocation(location, p.location) &&
    postedByAgency === stored &&
    title === p.title &&
    next.titleNorm === p.titleNorm &&
    next.roleArchetype === p.roleArchetype &&
    (next.levelBand ?? null) === (p.levelBand ?? null) &&
    jdText === p.jdText &&
    sameJson(next.jdSkills, p.jdSkills) &&
    sameJson(next.requirements, p.requirements) &&
    next.experience!.min === storedYears.min &&
    next.experience!.max === storedYears.max &&
    next.dedupKey === p.dedupKey;
  return unchanged ? null : next;
}

export async function renormalizePostings(store: RenormalizeStore): Promise<RenormalizeStats> {
  const stats: RenormalizeStats = {
    scanned: 0, changed: 0, locations: 0, multiCountry: 0, placed: 0, agencyFlagged: 0, agencyCleared: 0, noRaw: 0,
    jdCleaned: 0, archetypes: 0, levels: 0, skills: 0, experience: 0,
  };
  for (const p of await store.listActivePostings()) {
    stats.scanned++;
    if (!(typeof p.locationRaw === "string" && p.locationRaw.trim())) stats.noRaw++;
    // read before the write: a repo may hand back live objects
    const before = {
      location: p.location,
      agency: p.postedByAgency ?? false,
      jd: p.jdText,
      archetype: p.roleArchetype,
      level: p.levelBand ?? null,
      skills: [...p.jdSkills],
      years: { ...p.experience },
    };
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
    if (next.jdText !== undefined && next.jdText !== before.jd) stats.jdCleaned++;
    if (next.roleArchetype !== undefined && next.roleArchetype !== before.archetype) stats.archetypes++;
    if (next.levelBand !== undefined && (next.levelBand ?? null) !== before.level) stats.levels++;
    if (next.jdSkills && !sameJson(next.jdSkills, before.skills)) stats.skills++;
    if (next.experience && (next.experience.min !== before.years.min || next.experience.max !== before.years.max)) stats.experience++;
  }
  return stats;
}

/** a store that also records which normalize version its rows were derived with. */
export interface VersionedRenormalizeStore extends RenormalizeStore {
  getStoreMeta(key: string): Promise<string | null>;
  setStoreMeta(key: string, value: string): Promise<void>;
}

export interface RenormalizeRun extends RenormalizeStats {
  /** the version the store recorded before this run (null: never recorded) */
  fromVersion: number | null;
  toVersion: number;
}

/**
 * Re-derive stored postings once per NORMALIZE_VERSION (core): when the store's recorded
 * version is older than the code's (or was never recorded), run `renormalizePostings`, then
 * record the code's version — so a local install (CLI / web sync, which never run the worker)
 * picks up a parser fix on its next sync. Returns null when the store is already current. A
 * store recorded by NEWER code is left alone (an older process must not re-derive it back).
 * `force` re-runs regardless (`jobflow renormalize`). Idempotent: a second run changes nothing.
 */
export async function renormalizeIfStale(store: VersionedRenormalizeStore, opts: { force?: boolean } = {}): Promise<RenormalizeRun | null> {
  const recorded = await store.getStoreMeta(NORMALIZE_VERSION_KEY);
  const parsed = recorded == null ? null : Number(recorded);
  const fromVersion = parsed != null && Number.isFinite(parsed) ? parsed : null;
  if (!opts.force && fromVersion != null && fromVersion >= NORMALIZE_VERSION) return null;
  const stats = await renormalizePostings(store);
  if (fromVersion == null || fromVersion < NORMALIZE_VERSION) await store.setStoreMeta(NORMALIZE_VERSION_KEY, String(NORMALIZE_VERSION));
  return { ...stats, fromVersion, toVersion: NORMALIZE_VERSION };
}

/** one summary line for a renormalize run (CLI, sync log). */
export function renormalizeSummary(r: RenormalizeStats): string {
  return (
    `${r.scanned} scanned → ${r.changed} changed (${r.locations} locations: ${r.placed} newly placed, ${r.multiCountry} now multi-country; ` +
    `agency +${r.agencyFlagged} −${r.agencyCleared}; ${r.noRaw} stored without location text; ` +
    `${r.jdCleaned ?? 0} JDs cleaned, ${r.archetypes ?? 0} role types, ${r.levels ?? 0} levels, ${r.skills ?? 0} skill sets, ${r.experience ?? 0} years re-read)`
  );
}
