/**
 * Version of the stored-posting normalization (location parse + agency flag — what
 * `renormalizePostings` re-derives from a posting's own `locationRaw` / JD). A store records
 * the version its rows were derived with (`store_meta.normalize_version`); `pollAll` re-derives
 * stored postings once when this is newer, so a local install picks up a parser fix on its next
 * sync without running the worker (§11.3).
 *
 * BUMP IT whenever `parseLocation` / `looksLikeAgency` (or anything `renormalizePosting` calls)
 * changes what it returns for the same input. Re-running is idempotent, so an unneeded bump
 * costs one pass over the corpus and changes nothing.
 *
 * History: 1 = multi-place `countries`, local spellings, country_only, agency flag (third pass);
 * 2 = comma-separated place lists, named European primary country, country words aren't cities,
 *     ISO-3 / state-code forms, more places (fourth pass).
 */
export const NORMALIZE_VERSION = 2;

/** the `store_meta` key the version is recorded under. */
export const NORMALIZE_VERSION_KEY = "normalize_version";
