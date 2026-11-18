/**
 * Version of the stored-posting normalization (location parse, agency flag, cleaned JD and
 * title, and what they derive — what `renormalizePostings` re-derives from a posting's own
 * `locationRaw` / title / JD). A store records
 * the version its rows were derived with (`store_meta.normalize_version`); `pollAll` re-derives
 * stored postings once when this is newer, so a local install picks up a parser fix on its next
 * sync without running the worker (§11.3).
 *
 * BUMP IT whenever `parseLocation`, `looksLikeAgency`, `parseTitle`, `extractSkills`, `parseExperience`,
 * `cleanStoredJd` (or anything else `renormalizePosting` calls)
 * changes what it returns for the same input. Re-running is idempotent, so an unneeded bump
 * costs one pass over the corpus and changes nothing.
 *
 * History: 1 = multi-place `countries`, local spellings, country_only, agency flag (third pass);
 * 2 = comma-separated place lists, named European primary country, country words aren't cities,
 *     ISO-3 / state-code forms, more places (fourth pass);
 * 3 = taxonomy pass: JD markup / entity cleanup and title entities on stored rows; titles
 *     re-derived (`data_analytics` archetype, non-engineering head nouns, company level
 *     ladders, engineering-only title families); skills dictionary (SQL, BI tools, frontend
 *     frameworks, Swift / C / R …) with requirements + asked years re-read; whole multi-word
 *     cities ("San Francisco Bay Area", not "San"); cross-region remote country lists are
 *     `country_only`; dedup key recomputed.
 */
export const NORMALIZE_VERSION = 3;

/** the `store_meta` key the version is recorded under. */
export const NORMALIZE_VERSION_KEY = "normalize_version";
