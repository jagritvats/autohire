import type { FeedCard } from "@/lib/feed";
import { ageText, experienceText, locationText, payText, roleText } from "@/lib/cardText";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

/**
 * One job in a list (Jobs, Search). The title opens the Job page — the hub for deciding and
 * acting; the card's own buttons are the quick actions: Save, Tailor, Apply (→ the Job
 * page's apply checklist), Hide. Unscored cards (before onboarding) show no score at all.
 */
export function MatchCard({
  card,
  index,
  scored = true,
  selected = false,
  onSave,
  onHide,
  onInvalidate,
}: {
  card: FeedCard & { inFeed?: boolean };
  index: number;
  /** false before onboarding: no score, no fit judgement */
  scored?: boolean;
  /** keyboard focus on the Jobs page */
  selected?: boolean;
  onSave?: (card: FeedCard) => void;
  onHide?: (card: FeedCard) => void;
  /** only in the "Reported" collection: restore a listing marked invalid */
  onInvalidate?: (card: FeedCard) => void;
}) {
  const band = !scored ? "s-lo" : card.score >= 78 ? "s-hi" : card.score >= 60 ? "s-mid" : "s-lo";
  const geoBad = card.location.remoteGeo === "us_only" || card.location.remoteGeo === "eu_only";
  const locUncertain = card.location.confidence < 0.5;
  const locText = locationText(card);
  const exp = experienceText(card.experience);
  const pay = payText(card);
  const jobHref = `/jobs/${card.id}`;

  return (
    <article className="card" data-selected={selected || undefined} data-card-id={card.id} style={{ animationDelay: `${Math.min(index * 28, 600)}ms` }}>
      <div className="gutter">
        <span className={`bar ${band}`} />
        <span className={`score ${band}`} title={scored ? "How well this matches your profile (0–100)" : "Not scored — add your résumé to rank jobs for you"}>
          {scored ? card.score : "—"}
        </span>
      </div>

      <div className="body">
        <div className="row1">
          <a className="title ux-card-title" href={jobHref}>
            {card.title}
          </a>
          <a className="company" href={`/company/${card.companyId}`}>
            {card.company}
          </a>
          <span className="dot">·</span>
          <span className="loc">
            {geoBad ? <span className="geo-bad">{locText}</span> : locText}
            {locUncertain && (
              <span className="loc-uncertain" title="We couldn't read the location confidently — check it before applying">
                {" "}· check location
              </span>
            )}
          </span>
          {card.applied && <span className="applied-badge" title="This role is in your Applications">✓ in Applications</span>}
        </div>

        <div className="meta">
          <span className="tag fresh">
            <span className="pulse" />
            {ageText(card.ageDays)}
          </span>
          {card.atsDirect ? (
            <span className="tag ats" title="Straight from the employer's job board — complete and current">
              employer board
            </span>
          ) : (
            <span className="tag" title="Found on a job aggregator — check the original listing">
              via {card.source.replace(/_/g, " ")}
            </span>
          )}
          {TIER3.has(card.source) && <span className="tag tier3">found by your local agent</span>}
          {card.services && <span className="tag" title="IT-services / outsourcing employer">IT services</span>}
          {card.trust < 0.4 && (
            <span className="tag" title="This listing has signs of being stale, re-posted, or from an agency">
              low trust
            </span>
          )}
          {exp && (
            <span className="tag exp" data-fit={card.experience.fit ?? undefined} title="Years of experience the posting asks for">
              asks {exp}
            </span>
          )}
          {pay && (
            <span className="tag comp" data-estimate={pay.estimate || undefined} title={pay.title}>
              {pay.text}
            </span>
          )}
        </div>

        <div className="notes">
          {card.stackNote && (
            <div className="note">
              <span className="k">stack</span>
              <span className={/primary language/i.test(card.stackNote) ? "stack-lang" : ""}>{card.stackNote}</span>
            </div>
          )}
          {card.levelNote && (
            <div className="note">
              <span className="k">level</span>
              <span>{card.levelNote}</span>
            </div>
          )}
        </div>

        {card.skills.length > 0 && (
          <div className="skills">
            {card.skills.map((s) => (
              <span className="skill" key={s}>
                {s.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}

        {card.redFlags.length > 0 && (
          <div className="flags">
            {card.redFlags.map((f, i) => (
              <span className="flag" key={i}>
                {f}
              </span>
            ))}
          </div>
        )}

        {card.invalidated && card.invalidReason && (
          <div className="flags">
            <span className="flag invalid">reported · {card.invalidReason}</span>
          </div>
        )}
      </div>

      <div className="actions">
        <span className="arch">{roleText(card.archetype)}</span>
        {(card.presets ?? []).length > 0 && (
          <span className="preset-tags" title="The discovery presets this job belongs to">
            {card.presets.map((p) => (
              <span key={p} className="preset-tag">
                #{p}
              </span>
            ))}
          </span>
        )}
        <div className="action-btns">
          {onSave && (
            <button className="mini" data-on={card.bookmarked} onClick={() => onSave(card)} title={card.bookmarked ? "Remove from Saved" : "Save for later — it's added to Applications as Saved"}>
              {card.bookmarked ? "★ saved" : "☆ save"}
            </button>
          )}
          {onHide && (
            <button className="mini" onClick={() => onHide(card)} title={card.archived ? "Show it in your Jobs again" : "Not for me — hide it (find it under Hidden)"}>
              {card.archived ? "↺ unhide" : "hide"}
            </button>
          )}
          {onInvalidate && card.invalidated && (
            <button className="mini danger" onClick={() => onInvalidate(card)} title="Restore this listing">
              ↺ restore
            </button>
          )}
          <a className="tailor-link" href={`/tailor/${card.id}`} title="Draft a résumé, cover letter or answers for this job — from your own material">
            ✎ tailor
          </a>
          <a className="apply" href={`${jobHref}#apply`} title="See what's ready, open or pre-fill the form — you always submit">
            Apply →
          </a>
        </div>
      </div>
    </article>
  );
}
