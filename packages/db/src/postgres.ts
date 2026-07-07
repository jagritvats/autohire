import pg from "pg";
import type {
  AgentHeartbeat,
  Application,
  Company,
  ConnectedContext,
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
  ProfilePrefs,
  SalaryBand,
  ScoreBreakdown,
  TenantConfig,
} from "@jobflow/core";
import type {
  CompanyEnrichmentPatch,
  EnqueueJob,
  NewPosting,
  Repository,
  SalaryCacheEntry,
  UpsertCompany,
} from "./repository.js";

/**
 * Postgres-backed Repository. Works against Supabase's Postgres (point DATABASE_URL
 * at the project's connection string) or any local/VPS Postgres + pgvector path.
 * Same interface as InMemoryRepository, so callers are unchanged. Runs as the
 * service/owner role (RLS-bypassing) — the worker + local agent connect this way.
 */
export class PgRepository implements Repository {
  private pool: pg.Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("PgRepository requires DATABASE_URL");
    this.pool = new pg.Pool({
      connectionString,
      ssl: /supabase|amazonaws|render|neon/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
      max: 8,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
  private q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  // ── companies ──
  async upsertCompany(c: UpsertCompany): Promise<Company> {
    const { rows } = await this.q(
      `insert into company (name, name_norm, ats_type, ats_slug, careers_url, tags, poll_cadence)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (name_norm) do update set
         ats_type = case when excluded.ats_type <> 'unknown' then excluded.ats_type else company.ats_type end,
         ats_slug = coalesce(excluded.ats_slug, company.ats_slug),
         careers_url = coalesce(excluded.careers_url, company.careers_url),
         tags = (select array(select distinct unnest(company.tags || excluded.tags))),
         poll_cadence = excluded.poll_cadence
       returning *`,
      [c.name, c.nameNorm, c.atsType ?? "unknown", c.atsSlug ?? null, c.careersUrl ?? null, c.tags ?? [], c.pollCadence ?? "weekly"],
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
         enriched_at = now()
       where id = $1`,
      [
        id, p.compMedian ?? null, p.compCurrency ?? null, p.compSource ?? null,
        p.compBreakdown ? JSON.stringify(p.compBreakdown) : null,
        p.ratingOverall ?? null, p.ratingWlb ?? null, p.ratingComp ?? null, p.reviewCount ?? null,
        p.ratingSource ?? null, p.cultureSummary ?? null, p.interviewDifficulty ?? null,
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
         apply_url, jd_embedding, dedup_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       on conflict (ats_type, ats_job_id) do update set
         title = excluded.title, title_norm = excluded.title_norm,
         role_archetype = excluded.role_archetype, level_band = excluded.level_band,
         jd_text = excluded.jd_text, jd_skills = excluded.jd_skills, requirements = excluded.requirements,
         loc_mode = excluded.loc_mode, loc_city = excluded.loc_city, loc_country = excluded.loc_country,
         loc_tz = excluded.loc_tz, remote_geo = excluded.remote_geo, sponsorship = excluded.sponsorship,
         location_confidence = excluded.location_confidence,
         salary_min = excluded.salary_min, salary_max = excluded.salary_max, currency = excluded.currency,
         salary_source = excluded.salary_source, salary_confidence = excluded.salary_confidence,
         experience_min = excluded.experience_min, experience_max = excluded.experience_max,
         apply_url = excluded.apply_url, jd_embedding = excluded.jd_embedding,
         last_seen = now(), is_active = true,
         -- re-seen: clear staleness; a manual invalidated decision persists (§3)
         status = case when posting.status = 'stale' then 'active' else posting.status end,
         repost_count = posting.repost_count + case when posting.title_norm <> excluded.title_norm then 1 else 0 end
       returning *`,
      [
        p.companyId, p.companyName, p.atsType, p.atsJobId, p.source, p.tier, p.title, p.titleNorm,
        p.roleArchetype, p.levelBand, p.jdText, p.jdSkills, JSON.stringify(p.requirements),
        p.location.mode, p.location.city, p.location.country, p.location.timezone, p.location.remoteGeo, p.location.sponsorship, p.location.confidence,
        p.salary.min, p.salary.max, p.salary.currency, p.salary.source, p.salary.confidence,
        p.experience.min, p.experience.max,
        p.applyUrl, p.jdEmbedding ? JSON.stringify(p.jdEmbedding) : null, p.dedupKey,
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
  async setCanonical(postingId: string, canonicalId: string): Promise<void> {
    await this.q("update posting set canonical_id = $2 where id = $1", [postingId, canonicalId]);
  }
  async updatePostingSalary(id: string, band: SalaryBand): Promise<void> {
    await this.q(
      `update posting set salary_min = $2, salary_max = $3, currency = $4, salary_source = $5, salary_confidence = $6 where id = $1`,
      [id, band.min, band.max, band.currency, band.source, band.confidence],
    );
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
  async purgeOldPostings(opts: {
    olderThanDays: number;
    field?: "lastSeen" | "firstSeen";
    hard?: boolean;
  }): Promise<number> {
    const col = opts.field === "firstSeen" ? "first_seen" : "last_seen";
    // a manual invalidation outranks age; interval built from a bound int param.
    const cutoff = `now() - ($1 || ' days')::interval`;
    if (opts.hard) {
      const { rowCount } = await this.q(
        `delete from posting where status <> 'invalidated' and ${col} < ${cutoff}`,
        [String(opts.olderThanDays)],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.q(
      `update posting set is_active = false, status = 'stale'
       where status = 'active' and ${col} < ${cutoff}`,
      [String(opts.olderThanDays)],
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
      `insert into profile (id, tenant_id, master_resume, resume_latex, about_text, profile_embedding, yoe, level_band, prefs)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (tenant_id) do update set
         master_resume = excluded.master_resume, resume_latex = excluded.resume_latex,
         about_text = excluded.about_text, profile_embedding = excluded.profile_embedding,
         yoe = excluded.yoe, level_band = excluded.level_band, prefs = excluded.prefs`,
      [p.id, p.tenantId, p.masterResume, p.resumeLatex ?? "", p.aboutText ?? "", p.profileEmbedding ? JSON.stringify(p.profileEmbedding) : null, p.yoe, p.levelBand, JSON.stringify(p.prefs)],
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
      llmApiKey: r.llm_api_key ?? "",
      llmBaseUrl: r.llm_base_url ?? "",
      digestCadence: r.digest_cadence ?? "daily",
    };
  }
  async saveConfig(c: TenantConfig): Promise<TenantConfig> {
    await this.q(
      `insert into tenant_config (tenant_id, sources_enabled, automation_flags, llm_choice, llm_model, llm_api_key, llm_base_url, digest_cadence)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id) do update set
         sources_enabled = excluded.sources_enabled, automation_flags = excluded.automation_flags,
         llm_choice = excluded.llm_choice, llm_model = excluded.llm_model,
         llm_api_key = excluded.llm_api_key, llm_base_url = excluded.llm_base_url,
         digest_cadence = excluded.digest_cadence`,
      [c.tenantId, c.sourcesEnabled, JSON.stringify(c.automationFlags), c.llmChoice, c.llmModel ?? "", c.llmApiKey ?? "", c.llmBaseUrl ?? "", c.digestCadence],
    );
    return c;
  }
  async listEvidence(tenantId: string): Promise<Evidence[]> {
    const { rows } = await this.q("select * from evidence where tenant_id = $1", [tenantId]);
    return rows.map(rowToEvidence);
  }
  async saveEvidence(e: Evidence): Promise<Evidence> {
    await this.q(
      `insert into evidence (id, tenant_id, project, headline, detail, metric, tags, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         project = excluded.project, headline = excluded.headline, detail = excluded.detail,
         metric = excluded.metric, tags = excluded.tags, embedding = excluded.embedding`,
      [e.id, e.tenantId, e.project, e.headline, e.detail, e.metric, e.tags, e.embedding ? JSON.stringify(e.embedding) : null],
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
    // feed = rule-passing + active + non-invalidated/stale + not archived by this tenant
    const { rows } = await this.q(
      `select m.*, row_to_json(p.*) as posting from match m
       join posting p on p.id = m.posting_id
       left join posting_user_state s on s.posting_id = p.id and s.tenant_id = m.tenant_id
       where m.tenant_id = $1 and m.rule_pass = true and p.is_active = true and p.status = 'active'
         and coalesce(s.archived, false) = false
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
      estMin: num(r.est_min), estMax: num(r.est_max), currency: r.currency,
      source: r.source, confidence: r.confidence,
    };
  }
  async putSalaryCache(e: SalaryCacheEntry): Promise<void> {
    await this.q(
      `insert into salary_cache (key, role_archetype, location, est_min, est_max, currency, source, confidence, fetched_at, ttl)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now(), ($9 || ' days')::interval)
       on conflict (key) do update set
         role_archetype = excluded.role_archetype, location = excluded.location,
         est_min = excluded.est_min, est_max = excluded.est_max, currency = excluded.currency,
         source = excluded.source, confidence = excluded.confidence, fetched_at = now(), ttl = excluded.ttl`,
      [e.key, e.roleArchetype ?? null, e.location ?? null, e.estMin, e.estMax, e.currency, e.source, e.confidence, String(e.ttlDays ?? 14)],
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
  async claimJob(runtime: JobRuntime): Promise<Job | null> {
    const { rows } = await this.q(
      `update job set status = 'running', picked_at = now()
       where id = (
         select id from job where runtime = $1 and status = 'queued'
         order by created_at asc for update skip locked limit 1
       )
       returning *`,
      [runtime],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
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
}

// ── row mappers ──
function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}
function rowToCompany(r: pg.QueryResultRow): Company {
  return {
    id: r.id, name: r.name, nameNorm: r.name_norm, atsType: r.ats_type, atsSlug: r.ats_slug,
    careersUrl: r.careers_url, fundingStage: r.funding_stage, tags: r.tags ?? [], pollCadence: r.poll_cadence,
    lastPolled: r.last_polled, status: r.status, ratingOverall: num(r.rating_overall), ratingWlb: num(r.rating_wlb),
    ratingComp: num(r.rating_comp), reviewCount: r.review_count, ratingSource: r.rating_source,
    cultureSummary: r.culture_summary, interviewDifficulty: r.interview_difficulty,
    compMedian: num(r.comp_median), compCurrency: r.comp_currency ?? null, compSource: r.comp_source ?? null,
    compBreakdown: parseJson(r.comp_breakdown, null), compUpdatedAt: r.comp_updated_at ?? null,
    enrichedAt: r.enriched_at ?? null, createdAt: r.created_at,
  };
}
function rowToPosting(r: pg.QueryResultRow): Posting {
  const location: ParsedLocation = {
    mode: r.loc_mode, city: r.loc_city, country: r.loc_country, timezone: r.loc_tz,
    remoteGeo: r.remote_geo, sponsorship: r.sponsorship,
    confidence: num(r.location_confidence) ?? 0.5, // pre-migration rows → neutral
  };
  const salary: SalaryBand = {
    min: num(r.salary_min), max: num(r.salary_max), currency: r.currency,
    source: r.salary_source, confidence: r.salary_confidence,
  };
  const experience: ExperienceRange = { min: num(r.experience_min), max: num(r.experience_max) };
  return {
    id: r.id, companyId: r.company_id, companyName: r.company_name, atsType: r.ats_type, atsJobId: r.ats_job_id,
    source: r.source, tier: r.tier, title: r.title, titleNorm: r.title_norm, roleArchetype: r.role_archetype,
    levelBand: r.level_band, jdText: r.jd_text, jdSkills: r.jd_skills ?? [], requirements: parseJson(r.requirements, []),
    location, salary, experience, applyUrl: r.apply_url, jdEmbedding: parseJson(r.jd_embedding, null),
    firstSeen: r.first_seen, lastSeen: r.last_seen, isActive: r.is_active, repostCount: r.repost_count,
    status: r.status ?? "active", invalidReason: r.invalid_reason ?? null, invalidatedAt: r.invalidated_at ?? null,
    canonicalId: r.canonical_id, dedupKey: r.dedup_key,
  };
}
function rowToProfile(r: pg.QueryResultRow): Profile {
  return {
    id: r.id, tenantId: r.tenant_id, masterResume: r.master_resume, resumeLatex: r.resume_latex ?? "",
    aboutText: r.about_text ?? "",
    profileEmbedding: parseJson(r.profile_embedding, null),
    yoe: Number(r.yoe), levelBand: r.level_band, prefs: parseJson<ProfilePrefs>(r.prefs, {} as ProfilePrefs),
  };
}
function rowToContext(r: pg.QueryResultRow): ConnectedContext {
  return {
    id: r.id, tenantId: r.tenant_id, source: r.source, handle: r.handle ?? "", label: r.label ?? "",
    content: r.content ?? "", items: parseJson(r.items, []), enabled: r.enabled, syncedAt: r.synced_at,
  };
}
function rowToGeneration(r: pg.QueryResultRow): Generation {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id ?? null, kind: r.kind,
    prompt: r.prompt ?? "", content: r.content, model: r.model ?? "echo",
    inputHash: r.input_hash, createdAt: r.created_at,
  };
}
function rowToEvidence(r: pg.QueryResultRow): Evidence {
  return { id: r.id, tenantId: r.tenant_id, project: r.project, headline: r.headline, detail: r.detail, metric: r.metric, tags: r.tags ?? [], embedding: parseJson(r.embedding, null) };
}
function rowToMatch(r: pg.QueryResultRow): Match {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id, score: Number(r.score),
    scoreBreakdown: parseJson<ScoreBreakdown>(r.score_breakdown, {} as ScoreBreakdown), rulePass: r.rule_pass, whyFit: r.why_fit, gap: r.gap,
    stackNote: r.stack_note, levelNote: r.level_note, redFlags: r.red_flags ?? [], generatedAt: r.generated_at,
  };
}
function rowToApplication(r: pg.QueryResultRow): Application {
  return {
    id: r.id, tenantId: r.tenant_id, postingId: r.posting_id, status: r.status, appliedVia: r.applied_via,
    tailoredResumeUrl: r.tailored_resume_url, resumeVariant: r.resume_variant, answers: parseJson(r.answers, {}),
    submittedAt: r.submitted_at, nextAction: r.next_action, nextActionAt: r.next_action_at, outcome: r.outcome,
  };
}
function rowToJob(r: pg.QueryResultRow): Job {
  return {
    id: r.id, tenantId: r.tenant_id, type: r.type, runtime: r.runtime,
    payload: parseJson(r.payload, {}), status: r.status, result: parseJson(r.result, null),
    error: r.error, createdAt: r.created_at, pickedAt: r.picked_at, finishedAt: r.finished_at,
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
