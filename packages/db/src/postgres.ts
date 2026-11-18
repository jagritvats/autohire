import { ProfilePrefs as ProfilePrefsSchema, SearchQuery as SearchQuerySchema } from "@jobflow/core";
import type {
  AgentHeartbeat,
  ApiToken,
  Application,
  Company,
  ConnectedContext,
  DiscoverySource,
  Evidence,
  ExperienceRange,
  Generation,
  GenerationKind,
  Job,
  ProfileSourceKind,
  JobRuntime,
  JobStatus,
  Match,
  ParsedLocation,
  Posting,
  Profile,
  SalaryBand,
  SalaryEstimate,
  SyncRunRecord,
  SavedSearch,
  ScoreBreakdown,
  Session,
  Tenant,
  TenantConfig,
  User,
  UserRole,
} from "@jobflow/core";
import { decryptSecret, encryptSecret } from "./auth/crypto.js";
import type {
  CompanyEnrichmentPatch,
  EnqueueJob,
  NewPosting,
  PurgeOptions,
  Repository,
  SalaryCacheEntry,
  UpsertCompany,
} from "./repository.js";
import type { PostingNormalizedPatch } from "./repository.js";
import { SYNC_RUNS_KEPT } from "./repository.js";
import { pgPoolClient, sqlState, type SqlClient, type SqlRow } from "./sql.js";

/**
 * Postgres-backed Repository. Works against Supabase's Postgres (point DATABASE_URL
 * at the project's connection string), any local/VPS Postgres, or PGlite (the CLI's
 * zero-infra durable store) — all through a `SqlClient` running the same SQL.
 * Same interface + semantics as InMemoryRepository, so callers are unchanged. Runs as
 * the service/owner role (RLS-bypassing), so every tenant-scoped statement carries its
 * own `tenant_id` predicate.
 */
export class PgRepository implements Repository {
  private db: SqlClient;

  /** a SqlClient, or a connection string (default `DATABASE_URL`) for a pg pool. */
  constructor(client: SqlClient | string | undefined = process.env.DATABASE_URL) {
    if (client && typeof client === "object") this.db = client;
    else {
      if (!client) throw new Error("PgRepository requires DATABASE_URL");
      this.db = pgPoolClient(client);
    }
  }

  /** what this repo runs on: a Postgres server or embedded PGlite. */
  get kind(): SqlClient["kind"] {
    return this.db.kind;
  }
  get client(): SqlClient {
    return this.db;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
  private q<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []) {
    return this.db.query<T>(text, params);
  }

  // ── companies ──
  async upsertCompany(c: UpsertCompany): Promise<Company> {
    const { rows } = await this.q(
      `insert into company (name, name_norm, ats_type, ats_slug, careers_url, tags, poll_cadence)
       values ($1,$2,$3,$4,$5,$6,coalesce($7,'weekly'))
       on conflict (name_norm) do update set
         ats_type = case when excluded.ats_type <> 'unknown' then excluded.ats_type else company.ats_type end,
         ats_slug = coalesce(excluded.ats_slug, company.ats_slug),
         careers_url = coalesce(excluded.careers_url, company.careers_url),
         tags = (select array(select distinct unnest(company.tags || excluded.tags))),
         -- only an explicit cadence overrides (an aggregator mention must not reset a seed's "daily")
         poll_cadence = coalesce($7, company.poll_cadence)
       returning *`,
      [c.name, c.nameNorm, c.atsType ?? "unknown", c.atsSlug ?? null, c.careersUrl ?? null, c.tags ?? [], c.pollCadence ?? null],
    );
    return rowToCompany(rows[0]!);
  }

  async getCompany(id: string): Promise<Company | null> {
    const { rows } = await this.q("select * from company where id = $1", [id]);
    return rows[0] ? rowToCompany(rows[0]) : null;
  }
  async findCompanyByNameNorm(nameNorm: string): Promise<Company | null> {
    const { rows } = await this.q("select * from company where name_norm = $1", [nameNorm]);
    return rows[0] ? rowToCompany(rows[0]) : null;
  }
  async saveCompanyEnrichment(id: string, p: CompanyEnrichmentPatch): Promise<void> {
    await this.q(
      `update company set
         comp_median = coalesce($2, comp_median),
         comp_currency = coalesce($3, comp_currency),
         comp_source = coalesce($4, comp_source),
         comp_breakdown = coalesce($5, comp_breakdown),
         comp_updated_at = case when $2 is not null then now() else comp_updated_at end,
         rating_overall = coalesce($6, rating_overall),
         rating_wlb = coalesce($7, rating_wlb),
         rating_comp = coalesce($8, rating_comp),
         review_count = coalesce($9, review_count),
         rating_source = coalesce($10, rating_source),
         culture_summary = coalesce($11, culture_summary),
         interview_difficulty = coalesce($12, interview_difficulty),
         -- one entry per (source, market): drop that pair's previous entry, append the new one
         comp_benchmarks = case when $13::jsonb is null then comp_benchmarks else
           coalesce((select jsonb_agg(e) from jsonb_array_elements(comp_benchmarks) e
                     where not (e->>'source' = $13::jsonb->>'source' and e->>'market' = $13::jsonb->>'market')),
                    '[]'::jsonb) || jsonb_build_array($13::jsonb) end,
         enriched_at = now()
       where id = $1`,
      [
        id, p.compMedian ?? null, p.compCurrency ?? null, p.compSource ?? null,
        p.compBreakdown ? JSON.stringify(p.compBreakdown) : null,
        p.ratingOverall ?? null, p.ratingWlb ?? null, p.ratingComp ?? null, p.reviewCount ?? null,
        p.ratingSource ?? null, p.cultureSummary ?? null, p.interviewDifficulty ?? null,
        p.compBenchmark ? JSON.stringify(p.compBenchmark) : null,
      ],
    );
  }

  async listCompanies(filter?: { status?: string; dueForPoll?: boolean }): Promise<Company[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter?.dueForPoll) {
      where.push(`status = 'active' and (last_polled is null or
        (poll_cadence = 'daily' and last_polled < now() - interval '20 hours') or
        (poll_cadence = 'weekly' and last_polled < now() - interval '6 days'))`);
    }
    const { rows } = await this.q(`select * from company ${where.length ? "where " + where.join(" and ") : ""}`, params);
    return rows.map(rowToCompany);
  }

  async touchPolled(companyId: string): Promise<void> {
    await this.q("update company set last_polled = now() where id = $1", [companyId]);
  }
  async updateCompany(
    id: string,
    patch: { status?: Company["status"]; pollCadence?: Company["pollCadence"]; tags?: string[] },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.status) sets.push(`status = $${params.push(patch.status)}`);
    if (patch.pollCadence) sets.push(`poll_cadence = $${params.push(patch.pollCadence)}`);
    if (patch.tags) sets.push(`tags = $${params.push(patch.tags)}`);
    if (!sets.length) return;
    await this.q(`update company set ${sets.join(", ")} where id = $1`, params);
  }
  async deleteCompany(id: string): Promise<void> {
    await this.q("delete from company where id = $1", [id]); // postings cascade
  }
  async postingCountsByCompany(): Promise<Record<string, number>> {
    const { rows } = await this.q<{ company_id: string; n: string }>(
      "select company_id, count(*)::text as n from posting where is_active and status = 'active' group by company_id",
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.company_id] = Number(r.n);
    return out;
  }

  // ── postings ──
  async upsertPosting(p: NewPosting): Promise<Posting> {
    const { rows } = await this.q(
      `insert into posting (
         company_id, company_name, ats_type, ats_job_id, source, tier, title, title_norm,
         role_archetype, level_band, jd_text, jd_skills, requirements,
         loc_mode, loc_city, loc_country, loc_tz, remote_geo, sponsorship, location_confidence,
         salary_min, salary_max, currency, salary_source, salary_confidence,
         experience_min, experience_max,
         apply_url, jd_embedding, dedup_key, posted_at, posted_by_agency, embed_key, salary_raw,
         loc_countries, location_raw, salary_period, salary_basis, salary_equity)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
       on conflict (ats_type, ats_job_id) do update set
         -- identity (id, company_id, source, tier, first_seen) stays with the first write;
         -- everything derived from the fetched posting is refreshed, the dedup key included:
         -- it moves with the title, location and company spelling (and with a key change)
         company_name = excluded.company_name, dedup_key = excluded.dedup_key,
         title = excluded.title, title_norm = excluded.title_norm,
         role_archetype = excluded.role_archetype, level_band = excluded.level_band,
         jd_text = excluded.jd_text, jd_skills = excluded.jd_skills, requirements = excluded.requirements,
         loc_mode = excluded.loc_mode, loc_city = excluded.loc_city, loc_country = excluded.loc_country,
         loc_tz = excluded.loc_tz, remote_geo = excluded.remote_geo, sponsorship = excluded.sponsorship,
         location_confidence = excluded.location_confidence,
         loc_countries = excluded.loc_countries, location_raw = excluded.location_raw,
         salary_min = excluded.salary_min, salary_max = excluded.salary_max, currency = excluded.currency,
         salary_source = excluded.salary_source, salary_confidence = excluded.salary_confidence,
         salary_raw = excluded.salary_raw, salary_period = excluded.salary_period,
         salary_basis = excluded.salary_basis, salary_equity = excluded.salary_equity,
         -- salary_estimate is NOT touched: it belongs to the estimator's own pass (§11.4)
         experience_min = excluded.experience_min, experience_max = excluded.experience_max,
         apply_url = excluded.apply_url, jd_embedding = excluded.jd_embedding, embed_key = excluded.embed_key,
         posted_by_agency = excluded.posted_by_agency,
         -- keep the ORIGINAL publish date: boards re-stamp reposts with a new one (§3).
         -- least() ignores nulls, so a source that stops sending a date keeps ours.
         posted_at = least(posting.posted_at, excluded.posted_at),
         last_seen = now(), is_active = true,
         -- re-seen: clear staleness; a manual invalidated decision persists (§3)
         status = case when posting.status = 'stale' then 'active' else posting.status end,
         -- a repost: the title changed, or the source re-dated a job we already held (its
         -- new date is after our last sighting — counted once — and well after first_seen,
         -- so a relative "Posted 30+ Days Ago" drifting forward doesn't count)
         repost_count = posting.repost_count + case
           when posting.title_norm <> excluded.title_norm then 1
           when excluded.posted_at > posting.last_seen and excluded.posted_at > posting.first_seen + interval '2 days' then 1
           else 0 end
       returning *`,
      [
        p.companyId, p.companyName, p.atsType, p.atsJobId, p.source, p.tier, p.title, p.titleNorm,
        p.roleArchetype, p.levelBand, p.jdText, p.jdSkills, JSON.stringify(p.requirements),
        p.location.mode, p.location.city, p.location.country, p.location.timezone, p.location.remoteGeo, p.location.sponsorship, p.location.confidence,
        p.salary.min, p.salary.max, p.salary.currency, p.salary.source, p.salary.confidence,
        p.experience.min, p.experience.max,
        p.applyUrl, p.jdEmbedding ? JSON.stringify(p.jdEmbedding) : null, p.dedupKey,
        p.postedAt ?? null, p.postedByAgency ?? false, p.embedKey ?? null, p.salaryRaw ?? null,
        p.location.countries ?? null, p.locationRaw ?? null,
        p.salary.period ?? null, p.salary.basis ?? null, p.salary.equity ?? null,
      ],
    );
    return rowToPosting(rows[0]!);
  }

  async getPosting(id: string): Promise<Posting | null> {
    const { rows } = await this.q("select * from posting where id = $1", [id]);
    return rows[0] ? rowToPosting(rows[0]) : null;
  }
  async listActivePostings(): Promise<Posting[]> {
    const { rows } = await this.q("select * from posting where is_active = true and status = 'active'");
    return rows.map(rowToPosting);
  }
  async listPostingsByCompany(companyId: string): Promise<Posting[]> {
    const { rows } = await this.q(
      "select * from posting where company_id = $1 and is_active = true and status = 'active' order by first_seen desc",
      [companyId],
    );
    return rows.map(rowToPosting);
  }
  async setCanonical(postingId: string, canonicalId: string | null): Promise<void> {
    await this.q("update posting set canonical_id = $2 where id = $1", [postingId, canonicalId]);
  }
  async updatePostingSalary(id: string, band: SalaryBand, salaryRaw?: string | null): Promise<void> {
    await this.q(
      `update posting set salary_min = $2, salary_max = $3, currency = $4, salary_source = $5, salary_confidence = $6,
         salary_raw = case when $7::boolean then $8 else salary_raw end,
         salary_period = $9, salary_basis = $10, salary_equity = $11
       where id = $1`,
      [id, band.min, band.max, band.currency, band.source, band.confidence, salaryRaw !== undefined, salaryRaw ?? null,
        band.period ?? null, band.basis ?? null, band.equity ?? null],
    );
  }
  async updatePostingNormalized(id: string, patch: PostingNormalizedPatch): Promise<void> {
    const l = patch.location;
    const sets = [
      "loc_mode = $2", "loc_city = $3", "loc_country = $4", "loc_tz = $5", "remote_geo = $6", "sponsorship = $7",
      "location_confidence = $8", "loc_countries = $9", "posted_by_agency = $10",
    ];
    const params: unknown[] = [id, l.mode, l.city, l.country, l.timezone, l.remoteGeo, l.sponsorship, l.confidence, l.countries ?? null, patch.postedByAgency];
    // the title / JD derivations only when given — omitted ones stay as stored
    const opt = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.title !== undefined) opt("title", patch.title);
    if (patch.titleNorm !== undefined) opt("title_norm", patch.titleNorm);
    if (patch.roleArchetype !== undefined) opt("role_archetype", patch.roleArchetype);
    if (patch.levelBand !== undefined) opt("level_band", patch.levelBand);
    if (patch.jdText !== undefined) opt("jd_text", patch.jdText);
    if (patch.jdSkills !== undefined) opt("jd_skills", patch.jdSkills);
    if (patch.requirements !== undefined) opt("requirements", JSON.stringify(patch.requirements));
    if (patch.experience !== undefined) {
      opt("experience_min", patch.experience.min);
      opt("experience_max", patch.experience.max);
    }
    if (patch.dedupKey !== undefined) opt("dedup_key", patch.dedupKey);
    await this.q(`update posting set ${sets.join(", ")} where id = $1`, params);
  }
  async saveSalaryEstimates(updates: Array<{ id: string; estimate: SalaryEstimate | null }>): Promise<number> {
    let n = 0;
    // one statement per chunk — thousands of single-row updates would be thousands of round trips
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const { rowCount } = await this.q(
        `update posting p set salary_estimate = u.est
           from jsonb_to_recordset($1::jsonb) as u(id uuid, est jsonb)
          where p.id = u.id`,
        [JSON.stringify(chunk.map((u) => ({ id: u.id, est: u.estimate })))],
      );
      n += rowCount ?? 0;
    }
    return n;
  }
  async markStale(companyId: string, seenAtsJobIds: string[]): Promise<number> {
    const { rowCount } = await this.q(
      `update posting set is_active = false,
         status = case when status = 'invalidated' then status else 'stale' end
       where company_id = $1 and is_active = true and not (ats_job_id = any($2))`,
      [companyId, seenAtsJobIds.length ? seenAtsJobIds : [""]],
    );
    return rowCount ?? 0;
  }

  async touchSeen(companyId: string, atsJobIds: string[]): Promise<void> {
    if (!atsJobIds.length) return;
    await this.q(
      `update posting set last_seen = now(), is_active = true,
         status = case when status = 'stale' then 'active' else status end
       where company_id = $1 and ats_job_id = any($2)`,
      [companyId, atsJobIds],
    );
  }

  async findPostingsByAtsIds(atsType: Posting["atsType"], atsJobIds: string[]): Promise<Posting[]> {
    if (!atsJobIds.length) return [];
    const { rows } = await this.q("select * from posting where ats_type = $1 and ats_job_id = any($2)", [atsType, atsJobIds]);
    return rows.map(rowToPosting);
  }
  async retirePostings(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const { rowCount } = await this.q(
      `update posting set is_active = false,
         status = case when status = 'invalidated' then status else 'stale' end
       where id = any($1) and is_active = true`,
      [ids],
    );
    return rowCount ?? 0;
  }

  // ── posting lifecycle (manual, global) ──
  async invalidatePosting(id: string, reason: string): Promise<void> {
    await this.q(
      "update posting set status = 'invalidated', invalid_reason = $2, invalidated_at = now() where id = $1",
      [id, reason],
    );
  }
  async revalidatePosting(id: string): Promise<void> {
    // re-seen since? is_active tells us whether it's still on the board.
    await this.q(
      `update posting set
         status = case when is_active then 'active' else 'stale' end,
         invalid_reason = null, invalidated_at = null
       where id = $1 and status = 'invalidated'`,
      [id],
    );
  }
  async listInvalidatedPostings(): Promise<Posting[]> {
    const { rows } = await this.q("select * from posting where status = 'invalidated' order by invalidated_at desc");
    return rows.map(rowToPosting);
  }
  async purgeOldPostings(opts: PurgeOptions): Promise<number> {
    const col = opts.field === "firstSeen" ? "first_seen" : "last_seen";
    // a manual invalidation outranks age; interval built from a bound int param.
    const cutoff = `now() - ($1 || ' days')::interval`;
    const params: unknown[] = [String(opts.olderThanDays)];
    let sourceFilter = "";
    if (opts.sources?.length) {
      params.push(opts.sources);
      sourceFilter = ` and source = any($2)`;
    }
    if (opts.hard) {
      const { rowCount } = await this.q(
        `delete from posting where status <> 'invalidated' and ${col} < ${cutoff}${sourceFilter}`,
        params,
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.q(
      `update posting set is_active = false, status = 'stale'
       where status = 'active' and ${col} < ${cutoff}${sourceFilter}`,
      params,
    );
    return rowCount ?? 0;
  }

  // ── per-user posting overlay (archive + bookmark) ──
  async setPostingArchived(tenantId: string, postingId: string, archived: boolean): Promise<void> {
    await this.q(
      `insert into posting_user_state (tenant_id, posting_id, archived, archived_at, updated_at)
       values ($1, $2, $3, case when $3 then now() else null end, now())
       on conflict (tenant_id, posting_id) do update set
         archived = excluded.archived,
         archived_at = case when excluded.archived then coalesce(posting_user_state.archived_at, now()) else null end,
         updated_at = now()`,
      [tenantId, postingId, archived],
    );
  }
  async setPostingBookmarked(tenantId: string, postingId: string, bookmarked: boolean): Promise<void> {
    await this.q(
      `insert into posting_user_state (tenant_id, posting_id, bookmarked, bookmarked_at, updated_at)
       values ($1, $2, $3, case when $3 then now() else null end, now())
       on conflict (tenant_id, posting_id) do update set
         bookmarked = excluded.bookmarked,
         bookmarked_at = case when excluded.bookmarked then coalesce(posting_user_state.bookmarked_at, now()) else null end,
         updated_at = now()`,
      [tenantId, postingId, bookmarked],
    );
  }
  async getPostingUserState(tenantId: string): Promise<{ archived: Set<string>; bookmarked: Set<string> }> {
    const { rows } = await this.q<{ posting_id: string; archived: boolean; bookmarked: boolean }>(
      "select posting_id, archived, bookmarked from posting_user_state where tenant_id = $1 and (archived or bookmarked)",
      [tenantId],
    );
    const archived = new Set<string>();
    const bookmarked = new Set<string>();
    for (const r of rows) {
      if (r.archived) archived.add(r.posting_id);
      if (r.bookmarked) bookmarked.add(r.posting_id);
    }
    return { archived, bookmarked };
  }
  async listArchivedPostings(tenantId: string): Promise<Posting[]> {
    const { rows } = await this.q(
      `select p.* from posting p join posting_user_state s on s.posting_id = p.id
       where s.tenant_id = $1 and s.archived order by s.archived_at desc nulls last`,
      [tenantId],
    );
    return rows.map(rowToPosting);
  }
  async listBookmarkedPostings(tenantId: string): Promise<Posting[]> {
    const { rows } = await this.q(
      `select p.* from posting p join posting_user_state s on s.posting_id = p.id
       where s.tenant_id = $1 and s.bookmarked order by s.bookmarked_at desc nulls last`,
      [tenantId],
    );
    return rows.map(rowToPosting);
  }

  // ── profile / config / evidence ──
  async getProfile(tenantId: string): Promise<Profile | null> {
    const { rows } = await this.q("select * from profile where tenant_id = $1", [tenantId]);
    return rows[0] ? rowToProfile(rows[0]) : null;
  }
  async saveProfile(p: Profile): Promise<Profile> {
    await this.q(
      `insert into profile (id, tenant_id, master_resume, resume_latex, about_text, profile_embedding, yoe, level_band, prefs, onboarded_at, resume_file)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (tenant_id) do update set
         master_resume = excluded.master_resume, resume_latex = excluded.resume_latex,
         about_text = excluded.about_text, profile_embedding = excluded.profile_embedding,
         yoe = excluded.yoe, level_band = excluded.level_band, prefs = excluded.prefs,
         onboarded_at = excluded.onboarded_at, resume_file = excluded.resume_file`,
      [
        p.id, p.tenantId, p.masterResume, p.resumeLatex ?? "", p.aboutText ?? "",
        p.profileEmbedding ? JSON.stringify(p.profileEmbedding) : null, p.yoe, p.levelBand, JSON.stringify(p.prefs),
        p.onboardedAt ?? null, p.resumeFile ? JSON.stringify(p.resumeFile) : null,
      ],
    );
    return p;
  }
  async getConfig(tenantId: string): Promise<TenantConfig | null> {
    const { rows } = await this.q("select * from tenant_config where tenant_id = $1", [tenantId]);
    if (!rows[0]) return null;
    const r = rows[0];
    // normalize automation flags — tolerate both camelCase (app) and snake_case
    // (the SQL seed default) so the settings UI never gets undefined arrays.
    const af = (r.automation_flags ?? {}) as Record<string, unknown>;
    return {
      tenantId,
      sourcesEnabled: r.sources_enabled ?? [],
      automationFlags: {
        browser: af.browser === "on" ? "on" : "off",
        mode: af.mode === "fill" ? "fill" : "capture",
        autosubmit: false,
        rate: af.rate === "fast" ? "fast" : "human",
        tier3Sources: (af.tier3Sources ?? af.tier3_sources ?? []) as string[],
      },
      llmChoice: r.llm_choice ?? "echo",
      llmModel: r.llm_model ?? "",
      llmApiKey: readLlmKey(r),
      llmBaseUrl: r.llm_base_url ?? "",
      digestCadence: r.digest_cadence ?? "daily",
      discoveryPresets: r.discovery_presets ?? [],
      discoveryPreset: r.discovery_preset ?? "india",
      presetFeedsDisabled: r.preset_feeds_disabled ?? [],
    };
  }
  async saveConfig(c: TenantConfig): Promise<TenantConfig> {
    const { plain, enc } = writeLlmKey(c.llmApiKey ?? "");
    await this.q(
      `insert into tenant_config (tenant_id, sources_enabled, automation_flags, llm_choice, llm_model, llm_api_key, llm_api_key_enc,
         llm_base_url, digest_cadence, discovery_preset, preset_feeds_disabled, discovery_presets)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (tenant_id) do update set
         sources_enabled = excluded.sources_enabled, automation_flags = excluded.automation_flags,
         llm_choice = excluded.llm_choice, llm_model = excluded.llm_model,
         llm_api_key = excluded.llm_api_key, llm_api_key_enc = excluded.llm_api_key_enc,
         llm_base_url = excluded.llm_base_url, digest_cadence = excluded.digest_cadence,
         discovery_preset = excluded.discovery_preset, preset_feeds_disabled = excluded.preset_feeds_disabled,
         discovery_presets = excluded.discovery_presets`,
      [
        c.tenantId, c.sourcesEnabled, JSON.stringify(c.automationFlags), c.llmChoice, c.llmModel ?? "", plain, enc,
        c.llmBaseUrl ?? "", c.digestCadence, c.discoveryPreset ?? "india", c.presetFeedsDisabled ?? [], c.discoveryPresets ?? [],
      ],
    );
    return c;
  }
  async listEvidence(tenantId: string): Promise<Evidence[]> {
    const { rows } = await this.q("select * from evidence where tenant_id = $1", [tenantId]);
    return rows.map(rowToEvidence);
  }
  async saveEvidence(e: Evidence): Promise<Evidence> {
    // upsert by id — never across tenants (the WHERE turns a foreign id into a no-op)
    await this.q(
      `insert into evidence (id, tenant_id, project, headline, detail, metric, tags, embedding, origin)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set
         project = excluded.project, headline = excluded.headline, detail = excluded.detail,
         metric = excluded.metric, tags = excluded.tags, embedding = excluded.embedding, origin = excluded.origin
       where evidence.tenant_id = excluded.tenant_id`,
      [e.id, e.tenantId, e.project, e.headline, e.detail, e.metric, e.tags, e.embedding ? JSON.stringify(e.embedding) : null, e.origin ?? "manual"],
    );
    return e;
  }
  async deleteEvidence(tenantId: string, id: string): Promise<void> {
    await this.q("delete from evidence where tenant_id = $1 and id = $2", [tenantId, id]);
  }

  // ── matches ──
  async saveMatches(matches: Match[]): Promise<void> {
    for (const m of matches) {
      await this.q(
        `insert into match (id, tenant_id, posting_id, score, score_breakdown, rule_pass, why_fit, gap, stack_note, level_note, red_flags, generated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         on conflict (tenant_id, posting_id) do update set
           score = excluded.score, score_breakdown = excluded.score_breakdown, rule_pass = excluded.rule_pass,
           why_fit = excluded.why_fit, gap = excluded.gap, stack_note = excluded.stack_note,
           level_note = excluded.level_note, red_flags = excluded.red_flags, generated_at = now()`,
        [m.id, m.tenantId, m.postingId, m.score, JSON.stringify(m.scoreBreakdown), m.rulePass, m.whyFit, m.gap, m.stackNote, m.levelNote, m.redFlags],
      );
    }
  }
  async listMatches(tenantId: string, limit = 50): Promise<Array<Match & { posting: Posting }>> {
    // feed = rule-passing + active + non-invalidated/stale + not archived by this tenant +
    // a canonical posting (a match scored before its posting became a duplicate is stale)
    const { rows } = await this.q(
      `select m.*, row_to_json(p.*) as posting from match m
       join posting p on p.id = m.posting_id
       left join posting_user_state s on s.posting_id = p.id and s.tenant_id = m.tenant_id
       where m.tenant_id = $1 and m.rule_pass = true and p.is_active = true and p.status = 'active'
         and p.canonical_id is null and coalesce(s.archived, false) = false
       order by m.score desc limit $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({ ...rowToMatch(r), posting: rowToPosting(r.posting) }));
  }
  async listMatchesForPostings(tenantId: string, postingIds: string[]): Promise<Match[]> {
    if (postingIds.length === 0) return [];
    const { rows } = await this.q(
      "select * from match where tenant_id = $1 and posting_id = any($2)",
      [tenantId, postingIds],
    );
    return rows.map(rowToMatch);
  }

  // ── applications ──
  // ── store metadata ──
  async getStoreMeta(key: string): Promise<string | null> {
    const { rows } = await this.q("select value from store_meta where key = $1", [key]);
    return (rows[0]?.value as string | undefined) ?? null;
  }
  async setStoreMeta(key: string, value: string): Promise<void> {
    await this.q(
      `insert into store_meta (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, value],
    );
  }

  // ── salary cache ──
  async getSalaryCache(key: string): Promise<SalaryCacheEntry | null> {
    const { rows } = await this.q(
      "select * from salary_cache where key = $1 and fetched_at + ttl > now()",
      [key],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      key: r.key, roleArchetype: r.role_archetype, location: r.location,
      estMin: num(r.est_min), estMax: num(r.est_max), estMedian: num(r.est_median),
      sampleCount: r.sample_count ?? null, currency: r.currency,
      source: r.source, confidence: r.confidence,
    };
  }
  async putSalaryCache(e: SalaryCacheEntry): Promise<void> {
    await this.q(
      `insert into salary_cache (key, role_archetype, location, est_min, est_max, currency, source, confidence, fetched_at, ttl, est_median, sample_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now(), ($9 || ' days')::interval, $10, $11)
       on conflict (key) do update set
         role_archetype = excluded.role_archetype, location = excluded.location,
         est_min = excluded.est_min, est_max = excluded.est_max, currency = excluded.currency,
         source = excluded.source, confidence = excluded.confidence, fetched_at = now(), ttl = excluded.ttl,
         est_median = excluded.est_median, sample_count = excluded.sample_count`,
      [
        e.key, e.roleArchetype ?? null, e.location ?? null, e.estMin, e.estMax, e.currency, e.source, e.confidence,
        String(e.ttlDays ?? 14), e.estMedian ?? null, e.sampleCount ?? null,
      ],
    );
  }

  // ── generation cache ──
  async getGeneration(
    tenantId: string,
    postingId: string | null,
    kind: GenerationKind,
    prompt = "",
  ): Promise<Generation | null> {
    // posting_id is nullable, so match it with `is not distinct from` ($2 may be null).
    const { rows } = await this.q(
      `select * from generation
       where tenant_id = $1 and posting_id is not distinct from $2 and kind = $3 and prompt = $4
       order by created_at desc limit 1`,
      [tenantId, postingId, kind, prompt],
    );
    return rows[0] ? rowToGeneration(rows[0]) : null;
  }
  async listGenerations(tenantId: string, postingId?: string | null): Promise<Generation[]> {
    const where = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (postingId !== undefined) where.push(`posting_id is not distinct from $${params.push(postingId)}`);
    const { rows } = await this.q(
      `select * from generation where ${where.join(" and ")} order by created_at desc`,
      params,
    );
    return rows.map(rowToGeneration);
  }
  async saveGeneration(g: Generation): Promise<Generation> {
    // replace-the-slot (posting_id nullable → can't use ON CONFLICT cleanly)
    await this.q(
      "delete from generation where tenant_id = $1 and posting_id is not distinct from $2 and kind = $3 and prompt = $4",
      [g.tenantId, g.postingId, g.kind, g.prompt],
    );
    await this.q(
      `insert into generation (id, tenant_id, posting_id, kind, prompt, content, model, input_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [g.id, g.tenantId, g.postingId, g.kind, g.prompt, g.content, g.model, g.inputHash],
    );
    return g;
  }
  async clearGenerations(tenantId: string, opts?: { postingId?: string | null }): Promise<number> {
    if (opts && opts.postingId !== undefined) {
      const { rowCount } = await this.q(
        "delete from generation where tenant_id = $1 and posting_id is not distinct from $2",
        [tenantId, opts.postingId],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.q("delete from generation where tenant_id = $1", [tenantId]);
    return rowCount ?? 0;
  }

  // ── connected context ──
  async listContexts(tenantId: string): Promise<ConnectedContext[]> {
    const { rows } = await this.q("select * from connected_context where tenant_id = $1 order by source", [tenantId]);
    return rows.map(rowToContext);
  }
  async getContext(tenantId: string, source: ProfileSourceKind): Promise<ConnectedContext | null> {
    const { rows } = await this.q("select * from connected_context where tenant_id = $1 and source = $2", [tenantId, source]);
    return rows[0] ? rowToContext(rows[0]) : null;
  }
  async upsertContext(c: ConnectedContext): Promise<ConnectedContext> {
    await this.q(
      `insert into connected_context (id, tenant_id, source, handle, label, content, items, enabled, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (tenant_id, source) do update set
         handle = excluded.handle, label = excluded.label, content = excluded.content,
         items = excluded.items, enabled = excluded.enabled, synced_at = now()`,
      [c.id, c.tenantId, c.source, c.handle, c.label, c.content, JSON.stringify(c.items ?? []), c.enabled],
    );
    return c;
  }
  async setContextEnabled(tenantId: string, source: ProfileSourceKind, enabled: boolean): Promise<void> {
    await this.q("update connected_context set enabled = $3 where tenant_id = $1 and source = $2", [tenantId, source, enabled]);
  }
  async deleteContext(tenantId: string, source: ProfileSourceKind): Promise<void> {
    await this.q("delete from connected_context where tenant_id = $1 and source = $2", [tenantId, source]);
  }

  async upsertApplication(a: Application): Promise<Application> {
    await this.q(
      `insert into application (id, tenant_id, posting_id, status, applied_via, tailored_resume_url, resume_variant, answers, submitted_at, next_action, next_action_at, outcome)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (tenant_id, posting_id) do update set
         status = excluded.status, applied_via = excluded.applied_via,
         tailored_resume_url = excluded.tailored_resume_url, resume_variant = excluded.resume_variant,
         answers = excluded.answers, submitted_at = excluded.submitted_at,
         next_action = excluded.next_action, next_action_at = excluded.next_action_at, outcome = excluded.outcome`,
      [a.id, a.tenantId, a.postingId, a.status, a.appliedVia, a.tailoredResumeUrl, a.resumeVariant, JSON.stringify(a.answers), a.submittedAt, a.nextAction, a.nextActionAt, a.outcome],
    );
    return a;
  }
  async listApplications(tenantId: string): Promise<Application[]> {
    const { rows } = await this.q("select * from application where tenant_id = $1", [tenantId]);
    return rows.map(rowToApplication);
  }
  async listApplicationsWithPosting(tenantId: string): Promise<Array<Application & { posting: Posting | null }>> {
    const { rows } = await this.q(
      `select a.*, row_to_json(p.*) as posting from application a
       left join posting p on p.id = a.posting_id
       where a.tenant_id = $1 order by a.next_action_at asc nulls last`,
      [tenantId],
    );
    return rows.map((r) => ({ ...rowToApplication(r), posting: r.posting ? rowToPosting(r.posting) : null }));
  }
  async getApplicationByPosting(tenantId: string, postingId: string): Promise<Application | null> {
    const { rows } = await this.q("select * from application where tenant_id = $1 and posting_id = $2", [tenantId, postingId]);
    return rows[0] ? rowToApplication(rows[0]) : null;
  }
  async appliedDedupKeys(tenantId: string): Promise<Set<string>> {
    const { rows } = await this.q(
      "select distinct p.dedup_key from application a join posting p on p.id = a.posting_id where a.tenant_id = $1",
      [tenantId],
    );
    return new Set(rows.map((r) => r.dedup_key as string));
  }

  // ── jobs ──
  async enqueueJob(input: EnqueueJob): Promise<Job> {
    const { rows } = await this.q(
      `insert into job (tenant_id, type, runtime, payload) values ($1,$2,$3,$4) returning *`,
      [input.tenantId, input.type, input.runtime, JSON.stringify(input.payload ?? {})],
    );
    return rowToJob(rows[0]!);
  }
  /** Atomic claim — FOR UPDATE SKIP LOCKED so multiple workers never grab the same job. */
  async claimJob(runtime: JobRuntime, opts?: { tenantId?: string }): Promise<Job | null> {
    const { rows } = await this.q(
      `update job set status = 'running', picked_at = now()
       where id = (
         select id from job where runtime = $1 and status = 'queued'
           and ($2::uuid is null or tenant_id = $2::uuid)
         order by created_at asc for update skip locked limit 1
       )
       returning *`,
      [runtime, opts?.tenantId ?? null],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }
  async requeueStuckJobs(runtime: JobRuntime, olderThanMinutes: number): Promise<number> {
    const { rowCount } = await this.q(
      `update job set status = 'queued', picked_at = null
       where runtime = $1 and status = 'running'
         and picked_at < now() - ($2::double precision * interval '1 minute')`,
      [runtime, olderThanMinutes],
    );
    return rowCount;
  }
  async completeJob(
    id: string,
    status: Extract<JobStatus, "done" | "error">,
    payload: { result?: Record<string, unknown>; error?: string },
  ): Promise<void> {
    await this.q(
      `update job set status = $2, result = $3, error = $4, finished_at = now() where id = $1`,
      [id, status, payload.result ? JSON.stringify(payload.result) : null, payload.error ?? null],
    );
  }
  async listJobs(tenantId: string, limit = 30): Promise<Job[]> {
    const { rows } = await this.q(
      "select * from job where tenant_id = $1 order by created_at desc limit $2",
      [tenantId, limit],
    );
    return rows.map(rowToJob);
  }

  // ── heartbeat ──
  async upsertHeartbeat(h: AgentHeartbeat): Promise<void> {
    await this.q(
      `insert into agent_heartbeat (tenant_id, last_seen, version, flags, enabled_sources)
       values ($1, now(), $2, $3, $4)
       on conflict (tenant_id) do update set
         last_seen = now(), version = excluded.version, flags = excluded.flags, enabled_sources = excluded.enabled_sources`,
      [h.tenantId, h.version, JSON.stringify(h.flags ?? {}), h.enabledSources ?? []],
    );
  }
  async getHeartbeat(tenantId: string): Promise<AgentHeartbeat | null> {
    const { rows } = await this.q("select * from agent_heartbeat where tenant_id = $1", [tenantId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { tenantId, lastSeen: r.last_seen, version: r.version, flags: r.flags ?? {}, enabledSources: r.enabled_sources ?? [] };
  }
  // ── tenants + accounts ──
  async createTenant(input: { name: string; id?: string }): Promise<Tenant> {
    // idempotent when an id is given (first signup claiming the default tenant)
    const { rows } = await this.q(
      `insert into tenant (id, name) values (coalesce($1::uuid, uuid_generate_v4()), $2)
       on conflict (id) do nothing returning *`,
      [input.id ?? null, input.name],
    );
    if (rows[0]) return rowToTenant(rows[0]);
    const existing = await this.getTenant(input.id!);
    if (!existing) throw new Error(`createTenant: tenant ${input.id} vanished`);
    return existing;
  }
  async getTenant(id: string): Promise<Tenant | null> {
    const { rows } = await this.q("select * from tenant where id = $1", [id]);
    return rows[0] ? rowToTenant(rows[0]) : null;
  }
  async listTenants(opts?: { activeSinceDays?: number }): Promise<Tenant[]> {
    if (opts?.activeSinceDays == null) {
      const { rows } = await this.q("select * from tenant order by created_at, id");
      return rows.map(rowToTenant);
    }
    // a tenant never marked active (single-user / CLI) still counts — it is the operator
    const { rows } = await this.q(
      `select * from tenant
       where last_active_at is null or last_active_at >= now() - ($1::double precision * interval '1 day')
       order by created_at, id`,
      [opts.activeSinceDays],
    );
    return rows.map(rowToTenant);
  }
  async touchTenantActive(id: string): Promise<void> {
    await this.q("update tenant set last_active_at = now() where id = $1", [id]);
  }
  async createUser(input: { tenantId: string; email: string; passwordHash: string | null; role: UserRole }): Promise<User> {
    try {
      const { rows } = await this.q(
        `insert into app_user (tenant_id, email, password_hash, role) values ($1, $2, $3, $4) returning *`,
        [input.tenantId, input.email.trim().toLowerCase(), input.passwordHash, input.role],
      );
      return rowToUser(rows[0]!);
    } catch (e) {
      if (sqlState(e) === "23505") throw new Error("email already registered");
      throw e;
    }
  }
  async countUsers(): Promise<number> {
    const { rows } = await this.q<{ n: number }>("select count(*)::int as n from app_user");
    return Number(rows[0]?.n ?? 0);
  }
  async findUserByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null> {
    const { rows } = await this.q("select * from app_user where lower(email) = lower($1)", [email.trim()]);
    return rows[0] ? { ...rowToUser(rows[0]), passwordHash: rows[0].password_hash ?? null } : null;
  }
  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.q("select * from app_user where id = $1", [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }
  async setUserPassword(id: string, passwordHash: string): Promise<void> {
    await this.q("update app_user set password_hash = $2 where id = $1", [id, passwordHash]);
  }

  // ── sessions + API tokens (secrets stored as sha256 only) ──
  async createSession(s: Session & { secretHash: string }): Promise<void> {
    await this.q(
      `insert into auth_session (id, user_id, tenant_id, secret_hash, created_at, last_seen_at, expires_at, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, s.userId, s.tenantId, s.secretHash, s.createdAt, s.lastSeenAt, s.expiresAt, s.userAgent ?? null],
    );
  }
  async getSession(id: string): Promise<(Session & { secretHash: string }) | null> {
    const { rows } = await this.q("select * from auth_session where id = $1", [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, userId: r.user_id, tenantId: r.tenant_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at, userAgent: r.user_agent ?? null, secretHash: r.secret_hash,
    };
  }
  async touchSession(id: string, expiresAt: Date): Promise<void> {
    await this.q("update auth_session set last_seen_at = now(), expires_at = $2 where id = $1", [id, expiresAt]);
  }
  async deleteSession(id: string): Promise<void> {
    await this.q("delete from auth_session where id = $1", [id]);
  }
  async deleteUserSessions(userId: string, exceptId?: string): Promise<number> {
    const { rowCount } = await this.q(
      "delete from auth_session where user_id = $1 and ($2::text is null or id <> $2::text)",
      [userId, exceptId ?? null],
    );
    return rowCount;
  }
  async createApiToken(t: ApiToken & { secretHash: string }): Promise<void> {
    await this.q(
      `insert into api_token (id, tenant_id, user_id, name, scopes, secret_hash, created_at, last_used_at, expires_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.id, t.tenantId, t.userId ?? null, t.name, t.scopes, t.secretHash, t.createdAt, t.lastUsedAt ?? null, t.expiresAt ?? null, t.revokedAt ?? null],
    );
  }
  async getApiToken(id: string): Promise<(ApiToken & { secretHash: string }) | null> {
    const { rows } = await this.q("select * from api_token where id = $1", [id]);
    return rows[0] ? { ...rowToApiToken(rows[0]), secretHash: rows[0].secret_hash } : null;
  }
  async listApiTokens(tenantId: string): Promise<ApiToken[]> {
    const { rows } = await this.q("select * from api_token where tenant_id = $1 order by created_at, id", [tenantId]);
    return rows.map(rowToApiToken);
  }
  async revokeApiToken(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.q(
      "update api_token set revoked_at = now() where id = $2 and tenant_id = $1 and revoked_at is null",
      [tenantId, id],
    );
    return rowCount > 0;
  }
  async touchApiToken(id: string): Promise<void> {
    await this.q("update api_token set last_used_at = now() where id = $1", [id]);
  }

  // ── saved searches ──
  async listSavedSearches(tenantId: string): Promise<SavedSearch[]> {
    const { rows } = await this.q("select * from saved_search where tenant_id = $1 order by lower(name), name", [tenantId]);
    return rows.map(rowToSavedSearch);
  }
  async getSavedSearch(tenantId: string, id: string): Promise<SavedSearch | null> {
    const { rows } = await this.q("select * from saved_search where tenant_id = $1 and id = $2", [tenantId, id]);
    return rows[0] ? rowToSavedSearch(rows[0]) : null;
  }
  async saveSavedSearch(s: SavedSearch): Promise<SavedSearch> {
    const clash = () => new Error(`a saved search named "${s.name}" already exists`);
    const { rows: dup } = await this.q(
      "select 1 from saved_search where tenant_id = $1 and id <> $2 and lower(name) = lower($3) limit 1",
      [s.tenantId, s.id, s.name],
    );
    if (dup.length) throw clash();
    const { rows: own } = await this.q<{ tenant_id: string }>("select tenant_id from saved_search where id = $1", [s.id]);
    if (own[0] && own[0].tenant_id !== s.tenantId) throw new Error("saved search belongs to another tenant");
    try {
      await this.q(
        `insert into saved_search (id, tenant_id, name, query, as_source, as_view, cadence, enabled, last_run_at, last_result, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (id) do update set
           name = excluded.name, query = excluded.query, as_source = excluded.as_source, as_view = excluded.as_view,
           cadence = excluded.cadence, enabled = excluded.enabled,
           last_run_at = excluded.last_run_at, last_result = excluded.last_result
         where saved_search.tenant_id = excluded.tenant_id`,
        [
          s.id, s.tenantId, s.name, JSON.stringify(s.query), s.asSource, s.asView, s.cadence, s.enabled,
          s.lastRunAt ?? null, s.lastResult ? JSON.stringify(s.lastResult) : null, s.createdAt ?? new Date(),
        ],
      );
    } catch (e) {
      if (sqlState(e) === "23505") throw clash(); // lost a race to the unique (tenant, lower(name))
      throw e;
    }
    return s;
  }
  async deleteSavedSearch(tenantId: string, id: string): Promise<void> {
    await this.q("delete from saved_search where tenant_id = $1 and id = $2", [tenantId, id]);
  }
  async recordSavedSearchRun(tenantId: string, id: string, result: Record<string, unknown>): Promise<void> {
    await this.q(
      "update saved_search set last_run_at = now(), last_result = $3 where tenant_id = $1 and id = $2",
      [tenantId, id, JSON.stringify(result)],
    );
  }
  async listAllSourceSearches(): Promise<SavedSearch[]> {
    const { rows } = await this.q("select * from saved_search where enabled and as_source order by created_at, id");
    return rows.map(rowToSavedSearch);
  }

  // ── custom discovery sources ──
  async listDiscoverySources(tenantId: string): Promise<DiscoverySource[]> {
    const { rows } = await this.q("select * from discovery_source where tenant_id = $1 order by created_at, id", [tenantId]);
    return rows.map(rowToDiscoverySource);
  }
  async saveDiscoverySource(s: DiscoverySource): Promise<DiscoverySource> {
    // (tenant, configKey) is unique: adding the same feed twice returns the existing row
    const findDupe = async () => {
      const { rows } = await this.q(
        "select * from discovery_source where tenant_id = $1 and config_key = $2 and id <> $3",
        [s.tenantId, s.configKey, s.id],
      );
      return rows[0] ? rowToDiscoverySource(rows[0]) : null;
    };
    const dupe = await findDupe();
    if (dupe) return dupe;
    const { rows: own } = await this.q<{ tenant_id: string }>("select tenant_id from discovery_source where id = $1", [s.id]);
    if (own[0] && own[0].tenant_id !== s.tenantId) throw new Error("source belongs to another tenant");
    try {
      await this.q(
        `insert into discovery_source (id, tenant_id, label, config, config_key, enabled, last_run_at, last_status, last_count, last_error, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (id) do update set
           label = excluded.label, config = excluded.config, config_key = excluded.config_key, enabled = excluded.enabled,
           last_run_at = excluded.last_run_at, last_status = excluded.last_status,
           last_count = excluded.last_count, last_error = excluded.last_error
         where discovery_source.tenant_id = excluded.tenant_id`,
        [
          s.id, s.tenantId, s.label, JSON.stringify(s.config), s.configKey, s.enabled, s.lastRunAt ?? null,
          s.lastStatus ?? null, s.lastCount ?? null, s.lastError ?? null, s.createdAt ?? new Date(),
        ],
      );
    } catch (e) {
      if (sqlState(e) === "23505") {
        const raced = await findDupe(); // a concurrent add of the same feed won
        if (raced) return raced;
      }
      throw e;
    }
    return s;
  }
  async deleteDiscoverySource(tenantId: string, id: string): Promise<void> {
    await this.q("delete from discovery_source where tenant_id = $1 and id = $2", [tenantId, id]);
  }
  async recordDiscoverySourceRun(
    id: string,
    run: { status: "ok" | "empty" | "error"; count: number; error?: string | null },
  ): Promise<void> {
    await this.q(
      "update discovery_source set last_run_at = now(), last_status = $2, last_count = $3, last_error = $4 where id = $1",
      [id, run.status, run.count, run.error ?? null],
    );
  }
  async listAllEnabledDiscoverySources(): Promise<DiscoverySource[]> {
    const { rows } = await this.q("select * from discovery_source where enabled order by created_at, id");
    return rows.map(rowToDiscoverySource);
  }

  // ── company follows ──
  async followCompany(tenantId: string, companyId: string): Promise<void> {
    await this.q(
      "insert into company_follow (tenant_id, company_id) values ($1, $2) on conflict (tenant_id, company_id) do nothing",
      [tenantId, companyId],
    );
  }
  async unfollowCompany(tenantId: string, companyId: string): Promise<void> {
    await this.q("delete from company_follow where tenant_id = $1 and company_id = $2", [tenantId, companyId]);
  }
  async listFollowedCompanyIds(tenantId: string): Promise<string[]> {
    const { rows } = await this.q<{ company_id: string }>(
      "select company_id from company_follow where tenant_id = $1 order by created_at, company_id",
      [tenantId],
    );
    return rows.map((r) => r.company_id);
  }

  // ── sync runs ──
  async saveSyncRun(run: SyncRunRecord): Promise<void> {
    await this.q(
      `insert into sync_run (id, trigger, origin, status, started_at, finished_at, summary)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set
         status = excluded.status, finished_at = excluded.finished_at, summary = excluded.summary`,
      [run.id, run.trigger, run.origin, run.status, new Date(run.startedAt), run.finishedAt ? new Date(run.finishedAt) : null, JSON.stringify(run.summary)],
    );
    await this.q(
      `delete from sync_run where id not in (select id from sync_run order by started_at desc limit $1)`,
      [SYNC_RUNS_KEPT],
    );
  }
  async listSyncRuns(limit = 20): Promise<SyncRunRecord[]> {
    const { rows } = await this.q("select * from sync_run order by started_at desc limit $1", [limit]);
    return rows.map((r) => ({
      id: String(r.id),
      trigger: r.trigger as SyncRunRecord["trigger"],
      origin: r.origin as SyncRunRecord["origin"],
      status: r.status as SyncRunRecord["status"],
      startedAt: r.started_at as Date,
      finishedAt: (r.finished_at as Date | null) ?? null,
      summary: (typeof r.summary === "string" ? JSON.parse(r.summary) : r.summary) as SyncRunRecord["summary"],
    }));
  }
}

// ── LLM key at rest ──
// With JOBFLOW_SECRET_KEY set, the key is stored AES-256-GCM-encrypted in llm_api_key_enc
// and llm_api_key is blanked; without it, plaintext (single-user / legacy). Callers always
// see plaintext.
function secretKey(): string | null {
  return process.env.JOBFLOW_SECRET_KEY?.trim() || null;
}
function writeLlmKey(key: string): { plain: string; enc: string | null } {
  if (!key) return { plain: "", enc: null };
  const k = secretKey();
  return k ? { plain: "", enc: encryptSecret(key, k) } : { plain: key, enc: null };
}
let warnedLlmKey = false;
function readLlmKey(r: SqlRow): string {
  const enc = r.llm_api_key_enc as string | null | undefined;
  if (enc) {
    const k = secretKey();
    if (k) {
      try {
        return decryptSecret(enc, k);
      } catch (e) {
        if (!warnedLlmKey) console.warn(`[jobflow] stored LLM key could not be decrypted (${(e as Error).message}) — re-enter it in settings`);
      }
    } else if (!warnedLlmKey) {
      console.warn("[jobflow] an encrypted LLM key is stored but JOBFLOW_SECRET_KEY is not set — falling back to the env key");
    }
    warnedLlmKey = true;
  }
  return r.llm_api_key ?? "";
}

// ── row mappers ──
function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}
function rowToCompany(r: SqlRow): Company {
  return {
    id: r.id, name: r.name, nameNorm: r.name_norm, atsType: r.ats_type, atsSlug: r.ats_slug,
    careersUrl: r.careers_url, fundingStage: r.funding_stage, tags: r.tags ?? [], pollCadence: r.poll_cadence,
    lastPolled: r.last_polled, status: r.status, ratingOverall: num(r.rating_overall), ratingWlb: num(r.rating_wlb),
    ratingComp: num(r.rating_comp), reviewCount: r.review_count, ratingSource: r.rating_source,
    cultureSummary: r.culture_summary, interviewDifficulty: r.interview_difficulty,
    compMedian: num(r.comp_median), compCurrency: r.comp_currency ?? null, compSource: r.comp_source ?? null,
    compBreakdown: parseJson(r.comp_breakdown, null), compUpdatedAt: r.comp_updated_at ?? null,
    compBenchmarks: parseJson(r.comp_benchmarks, []),
    enrichedAt: r.enriched_at ?? null, createdAt: r.created_at,
  };
}
function rowToPosting(r: SqlRow): Posting {
  const location: ParsedLocation = {
    mode: r.loc_mode, city: r.loc_city, country: r.loc_country, timezone: r.loc_tz,
    remoteGeo: r.remote_geo, sponsorship: r.sponsorship,
    confidence: num(r.location_confidence) ?? 0.5, // pre-migration rows → neutral
    ...(r.loc_countries?.length ? { countries: r.loc_countries as string[] } : {}), // older rows → `country`
  };
  const salary: SalaryBand = {
    min: num(r.salary_min), max: num(r.salary_max), currency: r.currency,
    source: r.salary_source, confidence: r.salary_confidence,
    // how it was stated; absent on rows from before migration 0021 (= year, not said)
    ...(r.salary_period ? { period: r.salary_period } : {}),
    ...(r.salary_basis ? { basis: r.salary_basis } : {}),
    ...(r.salary_equity != null ? { equity: !!r.salary_equity } : {}),
  };
  const experience: ExperienceRange = { min: num(r.experience_min), max: num(r.experience_max) };
  return {
    id: r.id, companyId: r.company_id, companyName: r.company_name, atsType: r.ats_type, atsJobId: r.ats_job_id,
    source: r.source, tier: r.tier, title: r.title, titleNorm: r.title_norm, roleArchetype: r.role_archetype,
    levelBand: r.level_band, jdText: r.jd_text, jdSkills: r.jd_skills ?? [], requirements: parseJson(r.requirements, []),
    location, salary, experience, applyUrl: r.apply_url, jdEmbedding: parseJson(r.jd_embedding, null),
    salaryRaw: r.salary_raw ?? null, locationRaw: r.location_raw ?? null, salaryEstimate: parseJson<SalaryEstimate | null>(r.salary_estimate, null),
    postedByAgency: r.posted_by_agency ?? false, embedKey: r.embed_key ?? null,
    postedAt: r.posted_at ?? null, // pre-migration rows → fall back to firstSeen downstream
    firstSeen: r.first_seen, lastSeen: r.last_seen, isActive: r.is_active, repostCount: r.repost_count,
    status: r.status ?? "active", invalidReason: r.invalid_reason ?? null, invalidatedAt: r.invalidated_at ?? null,
    canonicalId: r.canonical_id, dedupKey: r.dedup_key,
  };
}
function rowToProfile(r: SqlRow): Profile {
  return {
    id: r.id, tenantId: r.tenant_id, masterResume: r.master_resume, resumeLatex: r.resume_latex ?? "",
    aboutText: r.about_text ?? "",
    profileEmbedding: parseJson(r.profile_embedding, null),
    yoe: Number(r.yoe), levelBand: r.level_band,
    // parse through Zod so rows saved before a prefs field existed get its default
    prefs: ProfilePrefsSchema.parse(parseJson<Record<string, unknown>>(r.prefs, {})),
    onboardedAt: r.onboarded_at ?? null,
    resumeFile: parseJson(r.resume_file, null),
  };
}
function rowToContext(r: SqlRow): ConnectedContext {
  return {
    id: r.id, tenantId: r.tenant_id, source: r.source, handle: r.handle ?? "", label: r.label ?? "",
    content: r.content ?? "", items: parseJson(r.items, []), enabled: r.enabled, syncedAt: r.synced_at,
  };
}
function rowToGeneration(r: SqlRow): Generation {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id ?? null, kind: r.kind,
    prompt: r.prompt ?? "", content: r.content, model: r.model ?? "echo",
    inputHash: r.input_hash, createdAt: r.created_at,
  };
}
function rowToEvidence(r: SqlRow): Evidence {
  return { id: r.id, tenantId: r.tenant_id, project: r.project, headline: r.headline, detail: r.detail, metric: r.metric, tags: r.tags ?? [], embedding: parseJson(r.embedding, null), origin: r.origin ?? "manual" };
}
function rowToMatch(r: SqlRow): Match {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id, score: Number(r.score),
    scoreBreakdown: parseJson<ScoreBreakdown>(r.score_breakdown, {} as ScoreBreakdown), rulePass: r.rule_pass, whyFit: r.why_fit, gap: r.gap,
    stackNote: r.stack_note, levelNote: r.level_note, redFlags: r.red_flags ?? [], generatedAt: r.generated_at,
  };
}
function rowToApplication(r: SqlRow): Application {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id, status: r.status, appliedVia: r.applied_via,
    tailoredResumeUrl: r.tailored_resume_url, resumeVariant: r.resume_variant, answers: parseJson(r.answers, {}),
    submittedAt: r.submitted_at, nextAction: r.next_action, nextActionAt: r.next_action_at, outcome: r.outcome,
  };
}
function rowToJob(r: SqlRow): Job {
  return {
    id: r.id, tenantId: r.tenant_id, type: r.type, runtime: r.runtime,
    payload: parseJson(r.payload, {}), status: r.status, result: parseJson(r.result, null),
    error: r.error, createdAt: r.created_at, pickedAt: r.picked_at, finishedAt: r.finished_at,
  };
}
function rowToTenant(r: SqlRow): Tenant {
  return { id: r.id, name: r.name, createdAt: r.created_at, lastActiveAt: r.last_active_at ?? null };
}
function rowToUser(r: SqlRow): User {
  return {
    id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role, externalId: r.external_id ?? null,
    createdAt: r.created_at, disabledAt: r.disabled_at ?? null,
  };
}
function rowToApiToken(r: SqlRow): ApiToken {
  return {
    id: r.id, tenantId: r.tenant_id, userId: r.user_id ?? null, name: r.name, scopes: r.scopes ?? [],
    createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, expiresAt: r.expires_at ?? null, revokedAt: r.revoked_at ?? null,
  };
}
function rowToSavedSearch(r: SqlRow): SavedSearch {
  const raw = parseJson<Record<string, unknown>>(r.query, {});
  // parse through Zod so rows saved before a query field existed get its default
  const q = SearchQuerySchema.safeParse(raw);
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, query: q.success ? q.data : (raw as SavedSearch["query"]),
    asSource: r.as_source, asView: r.as_view, cadence: r.cadence, enabled: r.enabled,
    lastRunAt: r.last_run_at ?? null, lastResult: parseJson(r.last_result, null), createdAt: r.created_at,
  };
}
function rowToDiscoverySource(r: SqlRow): DiscoverySource {
  return {
    id: r.id, tenantId: r.tenant_id, label: r.label ?? "", config: parseJson(r.config, {} as DiscoverySource["config"]),
    configKey: r.config_key, enabled: r.enabled, lastRunAt: r.last_run_at ?? null, lastStatus: r.last_status ?? null,
    lastCount: r.last_count == null ? null : Number(r.last_count), lastError: r.last_error ?? null, createdAt: r.created_at,
  };
}
function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === "object") return v as T; // pg already parsed jsonb
  try {
    return JSON.parse(v as string) as T;
  } catch {
    return fallback;
  }
}
