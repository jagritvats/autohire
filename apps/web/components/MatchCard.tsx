import type { FeedCard } from "@/lib/feed";
import { Badge, Icon } from "@/components/ui";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

/*
 * The card is the product. Scan path, top to bottom: score → title → company · location →
 * honesty badges (freshness, source, trust, YoE fit, pay — an estimate is always marked as
 * one) → stack/level notes → red flags → skills → actions. Nothing the scorer knows about
 * a caveat is hidden behind a hover; tooltips only add the "why".
 */
export function MatchCard({
  card,
  index: _index,
  onTrack,
  onBookmark,
  onArchive,
  onInvalidate,
}: {
  card: FeedCard;
  index: number;
  onTrack?: (card: FeedCard) => void;
  onBookmark?: (card: FeedCard) => void;
  onArchive?: (card: FeedCard) => void;
  onInvalidate?: (card: FeedCard) => void;
}) {
  const band = card.score >= 78 ? "hi" : card.score >= 60 ? "mid" : "lo";
  const geoBad = card.location.remoteGeo === "us_only" || card.location.remoteGeo === "eu_only";
  const locUncertain = card.location.confidence < 0.5;
  const locText =
    card.location.mode === "remote"
      ? `Remote · ${card.location.remoteGeo.replace("_", "-")}`
      : `${cap(card.location.mode)}${card.location.label ? ` · ${card.location.label}` : ""}`;
  const exp = expLabel(card.experience);
  const titleId = `match-${card.id}-title`;
  const presets = card.presets ?? [];

  return (
    <article className="match" aria-labelledby={titleId} data-invalid={card.invalidated || undefined}>
      <div className="match__score" data-band={band} aria-label={`Match score ${card.score} of 100`} role="img">
        <span className="score-num" aria-hidden="true">
          {card.score}
        </span>
        <span className="score-meter" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, card.score))}%` }} />
        </span>
      </div>

      <div className="match__body">
        <div className="match__head">
          <h2 className="match__title" id={titleId}>
            {card.title}
          </h2>
          <div className="match__kind">
            <span className="match__arch">{card.archetype.replace(/_/g, "/")}</span>
            {presets.length > 0 && (
              <span className="preset-tags" title="discovery presets this posting belongs to">
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
            <span className="loc-uncertain" title="Parsed location is low-confidence — verify before applying">
              · verify?
            </span>
          )}
          {card.applied && (
            <Badge tone="good">
              <Icon name="check" size={12} />
              in CRM
            </Badge>
          )}
        </div>

        <div className="match__tags">
          <Badge tone={card.ageDays <= 3 ? "good" : "neutral"} title="Days since the source first posted it">
            <span className="badge__dot" aria-hidden="true" />
            {card.ageDays <= 0 ? "today" : `${card.ageDays}d`}
          </Badge>
          {card.atsDirect ? <Badge tone="info">{card.ats} · ATS-direct</Badge> : <Badge>{card.source}</Badge>}
          {TIER3.has(card.source) && <Badge tone="warn">tier-3 · local</Badge>}
          {card.services && <Badge title="IT-services / outsourcing employer">IT services</Badge>}
          {card.trust < 0.4 && (
            <Badge tone="warn" title="Source trust: source prior × listing signals (agency, gig, re-dated, thin JD…)">
              low trust {Math.round(card.trust * 100)}%
            </Badge>
          )}
          {exp && (
            <Badge
              tone={card.experience.fit === "far" ? "bad" : card.experience.fit === "stretch" ? "warn" : "neutral"}
              title="Years of experience the JD asks for (parsed) vs yours"
            >
              {exp}
            </Badge>
          )}
          {card.comp && (
            <Badge
              estimate={card.comp.estimate}
              className="tag comp"
              data-estimate={card.comp.estimate || undefined}
              title={
                card.comp.estimate
                  ? `Estimated — the posting states no pay. ${card.comp.basis ?? ""}`
                  : `Stated in the posting (parse confidence: ${card.comp.confidence})`
              }
            >
              {card.comp.estimate ? "~" : ""}
              {card.comp.label}{" "}
              <span className="conf">
                · {card.comp.estimate ? `est ${Math.round((card.comp.confidenceScore ?? 0) * 100)}%` : card.comp.confidence}
              </span>
            </Badge>
          )}
        </div>

        {(card.stackNote || card.levelNote) && (
          <dl className="match__notes">
            {card.stackNote && (
              <>
                <dt>stack</dt>
                <dd className={isLangNote(card.stackNote) ? "stack-lang" : undefined}>{card.stackNote}</dd>
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
                <span>invalidated · {card.invalidReason}</span>
              </li>
            )}
          </ul>
        )}

        {card.skills.length > 0 && (
          <div className="match__skills" aria-label="Skills in the JD">
            {card.skills.map((s) => (
              <span className="match__skill" key={s}>
                {s.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="match__foot">
        <div className="match__manage">
          {onBookmark && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={card.bookmarked}
              onClick={() => onBookmark(card)}
              title={card.bookmarked ? "Remove bookmark" : "Bookmark"}
            >
              <Icon name="bookmark" size={14} />
              <span className="btn__text">{card.bookmarked ? "saved" : "save"}</span>
            </button>
          )}
          {onArchive && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onArchive(card)} title={card.archived ? "Unarchive" : "Archive (hide from feed)"}>
              <Icon name={card.archived ? "unarchive" : "archive"} size={14} />
              <span className="btn__text">{card.archived ? "unarchive" : "archive"}</span>
            </button>
          )}
          {onInvalidate && (
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--danger-quiet"
              aria-pressed={card.invalidated}
              onClick={() => onInvalidate(card)}
              title={card.invalidated ? "Restore" : "Mark invalid (spam/dupe/fake)"}
            >
              <Icon name={card.invalidated ? "restore" : "ban"} size={14} />
              <span className="btn__text">{card.invalidated ? "restore" : "invalid"}</span>
            </button>
          )}
        </div>
        <div className="match__go">
          <a className="btn btn--secondary btn--sm" href={`/tailor/${card.id}`} title="Tailor resume + answers for this role">
            <Icon name="pencil" size={14} />
            tailor
          </a>
          {onTrack &&
            (card.applied ? (
              <span className="btn btn--sm track tracked">
                <Icon name="check" size={14} />
                tracked
              </span>
            ) : (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onTrack(card)}>
                <Icon name="plus" size={14} />
                track
              </button>
            ))}
          {card.applyUrl ? (
            <a className="btn btn--primary btn--sm" href={card.applyUrl} target="_blank" rel="noreferrer">
              Apply
              <Icon name="arrowUpRight" size={14} />
              <span className="sr-only">(opens the posting in a new tab)</span>
            </a>
          ) : (
            <span className="btn btn--sm apply disabled" aria-disabled="true">
              no link
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** "~2–3 yrs" style label for the parsed YoE band (§11.2); null when unstated. */
function expLabel(e: { min: number | null; max: number | null }): string | null {
  const { min, max } = e;
  if (min == null && max == null) return null;
  if (min != null && max != null)
    return min === max ? `~${min} yr${min === 1 ? "" : "s"}` : `~${min}–${max} yrs`;
  if (min != null) return `~${min}+ yrs`;
  return `≤${max} yrs`;
}
function isLangNote(note: string) {
  return /primary language/i.test(note);
}
