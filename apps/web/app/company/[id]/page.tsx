import Link from "next/link";
import { notFound } from "next/navigation";
import { LEVELS_ATTRIBUTION } from "@jobflow/adapters";
import type { Posting } from "@jobflow/core";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ params }: { params: { id: string } }) {
  const repo = await getRepo();
  const company = await repo.getCompany(params.id);
  if (!company) notFound();
  const postings = await repo.listPostingsByCompany(params.id);

  return (
    <div className="settings-shell">
      <header className="settings-head">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span> <span className="settings-sub">/ {company.name}</span>
        </h1>
        <Link className="back" href="/">
          ← feed
        </Link>
      </header>

      <div className="company-grid">
        <section className="card-block">
          <h3>Profile</h3>
          <div className="kv">
            <span>ATS</span>
            <span>{company.atsType === "unknown" ? "unresolved" : `${company.atsType} / ${company.atsSlug}`}</span>
          </div>
          <div className="kv">
            <span>status</span>
            <span className={`rstatus s-${company.status}`}>{company.status}</span>
          </div>
          <div className="kv">
            <span>active postings</span>
            <span className="rcount">{postings.length}</span>
          </div>
          {company.tags.length > 0 && (
            <div className="kv">
              <span>tags</span>
              <span>{company.tags.join(" · ")}</span>
            </div>
          )}
        </section>

        <section className="card-block">
          <h3>Compensation <span className="hint">benchmark</span></h3>
          {company.compMedian != null ? (
            <>
              <div className="comp-median">
                {fmt(company.compMedian, company.compCurrency ?? "USD")}
                <span className="comp-median-l">median total comp · all roles</span>
              </div>
              {company.compBreakdown && company.compBreakdown.length > 0 && (
                <div className="fam-table">
                  {company.compBreakdown.slice(0, 8).map((f) => (
                    <div className="fam-row" key={f.family}>
                      <span>{f.family}</span>
                      <span className="fam-med">{fmt(f.median, company.compCurrency ?? "USD")}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="attribution">{LEVELS_ATTRIBUTION}</div>
            </>
          ) : (
            <div className="empty-note">No comp benchmark yet — run “Enrich comp” (levels.fyi, free).</div>
          )}
        </section>

        <section className="card-block">
          <h3>Ratings <span className="hint">& culture</span></h3>
          {company.ratingOverall != null ? (
            <>
              <div className="rating-big">{company.ratingOverall.toFixed(1)}★ <span className="hint">{company.reviewCount ?? 0} reviews · {company.ratingSource}</span></div>
              {company.cultureSummary && <p className="risk">{company.cultureSummary}</p>}
              {company.interviewDifficulty && <div className="kv"><span>interview</span><span>{company.interviewDifficulty}</span></div>}
            </>
          ) : (
            <div className="empty-note">
              Ratings come from AmbitionBox / Glassdoor — <strong>Tier 3</strong>, captured by your local agent
              (Phase 4), never the server.
            </div>
          )}
        </section>
      </div>

      <section className="card-block" style={{ marginTop: 16 }}>
        <h3>Open postings <span className="hint">({postings.length})</span></h3>
        <div className="cp-list">
          {postings.slice(0, 40).map((p) => (
            <div className="cp-row" key={p.id}>
              <span className="cp-title">{p.title}</span>
              <span className="cp-meta">{p.levelBand ?? "—"} · {p.location.mode}{p.location.city ? ` · ${p.location.city}` : ""}</span>
              <span className="cp-comp">{compStr(p)}</span>
              {p.applyUrl ? (
                <a className="cp-apply" href={p.applyUrl} target="_blank" rel="noreferrer">apply →</a>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function fmt(n: number, cur: string): string {
  if (cur === "INR") return `₹${(n / 100000).toFixed(1)}L`;
  if (cur === "USD") return `$${Math.round(n / 1000)}k`;
  return `${Math.round(n / 1000)}k ${cur}`;
}
function compStr(p: Posting): string {
  const s = p.salary;
  if (s.min == null && s.max == null) return "";
  const range = s.min != null && s.max != null ? `${fmt(s.min, s.currency)}–${fmt(s.max, s.currency)}` : `${fmt((s.min ?? s.max)!, s.currency)}+`;
  return `${range} · ${s.confidence}`;
}
