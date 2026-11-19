import Link from "next/link";
import { AppFrame } from "@/components/AppFrame";
import { Icon } from "@/components/ui";
import { notFound } from "next/navigation";
import { LEVELS_ATTRIBUTION } from "@jobflow/adapters";
import { describePay, formatSalary, payDisplayOptions, type FormatPayOptions, type Posting } from "@jobflow/core";
import { getRepo } from "@/lib/repo";
import { pageAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await pageAuth(`/company/${id}`);
  const repo = await getRepo();
  // pay in the reader's "show pay in" currency / period
  const show = payDisplayOptions((await repo.getProfile(tenantId))?.prefs);
  const company = await repo.getCompany(id);
  if (!company) notFound();
  const postings = await repo.listPostingsByCompany(id);

  return (
    <AppFrame
      wide
      title={company.name}
      eyebrow={
        <>
          <Link href="/">
            <Icon name="arrowLeft" size={14} /> Jobs
          </Link>{" "}
          · <Link href="/companies">All companies</Link>
        </>
      }
    >

      <div className="company-grid">
        <section className="card-block">
          <h2>Profile</h2>
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
          <h2>Compensation <span className="hint">benchmark</span></h2>
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
          {(company.compBenchmarks ?? []).filter((b) => b.roles.length > 0).map((b) => (
            <div key={`${b.source}:${b.market}`} style={{ marginTop: 12 }}>
              <div className="comp-median-l">
                {b.source === "ambitionbox" ? "AmbitionBox" : b.source === "levelsfyi" ? "levels.fyi" : b.source} · {b.market} ·{" "}
                {b.basis === "ctc" ? "CTC by designation" : b.basis === "total_comp" ? "total comp by level" : "base by role"}
              </div>
              <div className="fam-table">
                {b.roles.slice(0, 8).map((r) => (
                  <div className="fam-row" key={r.title}>
                    <span>{r.title}{r.levelBand ? ` · ${r.levelBand}` : ""}</span>
                    <span className="fam-med">{fmt(r.median, b.currency)}</span>
                  </div>
                ))}
              </div>
              {b.source === "levelsfyi" && <div className="attribution">{LEVELS_ATTRIBUTION}</div>}
            </div>
          ))}
        </section>

        <section className="card-block">
          <h2>Ratings <span className="hint">& culture</span></h2>
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
        <h2>Open postings <span className="hint">({postings.length})</span></h2>
        <div className="cp-list">
          {postings.slice(0, 40).map((p) => (
            <div className="cp-row" key={p.id}>
              <span className="cp-title">{p.title}</span>
              <span className="cp-meta">{p.levelBand ?? "—"} · {p.location.mode}{p.location.city ? ` · ${p.location.city}` : ""}</span>
              <span className="cp-comp">{compStr(p, show)}</span>
              {p.applyUrl ? (
                <a className="cp-apply" href={p.applyUrl} target="_blank" rel="noreferrer">apply →</a>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      </section>
    </AppFrame>
  );
}

function fmt(n: number, cur: string): string {
  return formatSalary(n, cur);
}
function compStr(p: Posting, show: Pick<FormatPayOptions, "currency" | "period">): string {
  const pay = describePay(p, show);
  if (!pay) return "";
  return pay.estimate ? `${pay.label} · ${Math.round((pay.confidenceScore ?? 0) * 100)}%` : `${pay.label} · ${pay.confidence}`;
}
