import type { FeedCard } from "@/lib/feed";
import { ageText, experienceText, locationText, payText, roleText } from "@/lib/cardText";
import { Badge, Icon } from "@/components/ui";
import { skillText } from "@jobflow/core";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

/*
 * One job in a list (Jobs, Search) — the card is the product. Scan path, top to bottom:
 * score → title (opens the Job page, the hub for deciding and acting) → company · location →
 * honesty badges (freshness, source, trust, YoE asked, pay — an estimate is always marked as
 * one) → stack/level notes → red flags → skills → quick actions (Save, Hide, Tailor, Apply →
 * the Job page's apply checklist). Unscored cards (before onboarding) show no score and no
 * fit judgement. Nothing the scorer knows about a caveat hides behind a hover; tooltips only
 * add the "why".
 */
export function MatchCard({
  card,
  index: _index,
  scored = true,
  selected = false,
  onSave,
  onHide,
  onInvalidate,
  moreAtCompany = 0,
}: {
  card: FeedCard & { inFeed?: boolean };
  /** this company's cards further down the list (the spread or the page put them there) */
  moreAtCompany?: number;
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
  const band = !scored ? "none" : card.score >= 78 ? "hi" : card.score >= 60 ? "mid" : "lo";
  const geoBad = card.location.remoteGeo === "us_only" || card.location.remoteGeo === "eu_only";
  const locUncertain = card.location.confidence < 0.5;
  const locText = locationText(card);
  const exp = experienceText(card.experience);
  const pay = payText(card);
  const jobHref = `/jobs/${card.id}`;
  const titleId = `match-${card.id}-title`;
  const presets = card.presets ?? [];

  return (
    <article
      className="match"
      aria-labelledby={titleId}
      data-selected={selected || undefined}
      data-card-id={card.id}
      data-invalid={card.invalidated || undefined}
    >
      {scored ? (
        <div className="match__score" data-band={band} aria-label={`Match score ${card.score} of 100`} role="img" title="How well this matches your profile (0–100)">
          <span className="score-num" aria-hidden="true">
            {card.score}
          </span>
          <span className="score-meter" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, card.score))}%` }} />
          </span>
        </div>
      ) : (
        <div className="match__score" data-band="none" title="Not scored — add your résumé to rank jobs for you">
          <span className="score-num" aria-hidden="true">
            —
          </span>
          <span className="sr-only">Not scored yet</span>
        </div>
      )}

      <div className="match__body">
        <div className="match__head">
          <h2 className="match__title" id={titleId}>
            <a className="match__title-link" href={jobHref}>
              {card.title}
            </a>
          </h2>
          <div className="match__kind">
            <span className="match__arch">{roleText(card.archetype)}</span>
            {presets.length > 0 && (
              <span className="preset-tags" title="The discovery presets this job belongs to">
                {presets.map((p) => (
                  <span key={p} className="match__preset">
                    #{p}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>

        <div className="match__sub">
          <a className="match__company" href={`/company/${card.companyId}`}>
            {card.company}
          </a>
          <span className="dot" aria-hidden="true">
            ·
          </span>
          <span className={geoBad ? "loc--warn" : undefined}>
            {geoBad && <Icon name="warn" size={13} />} {locText}
          </span>
          {locUncertain && (
            <span className="loc-uncertain" title="We couldn't read the location confidently — check it before applying">
              · check location
            </span>
          )}
          {card.applied && (
            <Badge tone="good" title="This role is in your Applications">
              <Icon name="check" size={12} />
              in Applications
            </Badge>
          )}
        </div>

        <div className="match__tags">
          <Badge tone={card.ageDays <= 3 ? "good" : "neutral"} title="When the source first posted it">
            <span className="badge__dot" aria-hidden="true" />
            {ageText(card.ageDays)}
          </Badge>
          {card.atsDirect ? (
            <Badge tone="info" title="Straight from the employer's job board — complete and current">
              employer board
            </Badge>
          ) : (
            <Badge title="Found on a job aggregator — check the original listing">via {card.source.replace(/_/g, " ")}</Badge>
          )}
          {TIER3.has(card.source) && <Badge tone="warn">found by your local agent</Badge>}
          {card.agency && (
            <Badge tone="warn" title="A recruiter posted this for a client, not the employer itself — the client may be unnamed and replies are usually slower">
              staffing agency
            </Badge>
          )}
          {card.services && <Badge title="IT-services / outsourcing employer">IT services</Badge>}
          {card.trust < 0.4 && (
            <Badge tone="warn" title="This listing has signs of being stale, re-posted, or from an agency">
              low trust {Math.round(card.trust * 100)}%
            </Badge>
          )}
          {exp && (
            <Badge
              tone={scored && card.experience.fit === "far" ? "bad" : scored && card.experience.fit === "stretch" ? "warn" : "neutral"}
              data-fit={card.experience.fit ?? undefined}
              title="Years of experience the posting asks for"
            >
              asks {exp}
            </Badge>
          )}
          {card.comp && pay && (
            <Badge estimate={pay.estimate} className="tag comp" data-estimate={pay.estimate || undefined} title={pay.title}>
              {pay.estimate ? "~" : ""}
              {card.comp.label}{" "}
              <span className="conf">
                · {pay.estimate ? `est ${Math.round((card.comp.confidenceScore ?? 0) * 100)}%` : card.comp.confidence}
              </span>
            </Badge>
          )}
        </div>

        {(card.stackNote || card.levelNote) && (
          <dl className="match__notes">
            {card.stackNote && (
              <>
                <dt>stack</dt>
                <dd className={/primary language/i.test(card.stackNote) ? "stack-lang" : undefined}>{card.stackNote}</dd>
              </>
            )}
            {card.levelNote && (
              <>
                <dt>level</dt>
                <dd>{card.levelNote}</dd>
              </>
            )}
          </dl>
        )}

        {(card.redFlags.length > 0 || (card.invalidated && card.invalidReason)) && (
          <ul className="match__flags" aria-label="Flags">
            {card.redFlags.map((f, i) => (
              <li className="match__flag" key={i}>
                <Icon name="warn" size={14} />
                <span>{f}</span>
              </li>
            ))}
            {card.invalidated && card.invalidReason && (
              <li className="match__flag match__flag--bad">
                <Icon name="ban" size={14} />
                <span>reported · {card.invalidReason}</span>
              </li>
            )}
          </ul>
        )}

        {card.siblings?.length > 0 && (
          <p className="match__more">
            Also posted for{" "}
            {card.siblings.map((sib, i) => (
              <span key={sib.id}>
                {i > 0 ? ", " : ""}
                <a href={`/jobs/${sib.id}`}>{sib.place}</a>
              </span>
            ))}
          </p>
        )}

        {moreAtCompany > 0 && (
          <p className="match__more">
            <a href={`/company/${card.companyId}`}>
              +{moreAtCompany} more at {card.company} further down
            </a>
          </p>
        )}

        {card.skills.length > 0 && (
          <div className="match__skills" aria-label="Skills in the posting">
            {card.skills.map((s) => (
              <span className="match__skill" key={s}>
                {skillText(s)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="match__foot">
        <div className="match__manage">
          {onSave && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={card.bookmarked}
              onClick={() => onSave(card)}
              title={card.bookmarked ? "Remove from Saved" : "Save for later — it's added to Applications as Saved"}
            >
              <Icon name="bookmark" size={14} />
              <span className="btn__text">{card.bookmarked ? "saved" : "save"}</span>
            </button>
          )}
          {onHide && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onHide(card)}
              title={card.archived ? "Show it in your Jobs again" : "Not for me — hide it (find it under Hidden)"}
            >
              <Icon name={card.archived ? "unarchive" : "archive"} size={14} />
              <span className="btn__text">{card.archived ? "unhide" : "hide"}</span>
            </button>
          )}
          {onInvalidate && card.invalidated && (
            <button type="button" className="btn btn--ghost btn--sm btn--danger-quiet" onClick={() => onInvalidate(card)} title="Restore this listing">
              <Icon name="restore" size={14} />
              <span className="btn__text">restore</span>
            </button>
          )}
        </div>
        <div className="match__go">
          <a className="btn btn--secondary btn--sm" href={`/tailor/${card.id}`} title="Draft a résumé, cover letter or answers for this job — from your own material">
            <Icon name="pencil" size={14} />
            tailor
          </a>
          <a className="btn btn--primary btn--sm" href={`${jobHref}#apply`} title="See what's ready, open or pre-fill the form — you always submit">
            Apply →
          </a>
        </div>
      </div>
    </article>
  );
}
