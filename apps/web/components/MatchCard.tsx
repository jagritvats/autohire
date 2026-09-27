import type { FeedCard } from "@/lib/feed";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

export function MatchCard({
  card,
  index,
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
  const band = card.score >= 78 ? "s-hi" : card.score >= 60 ? "s-mid" : "s-lo";
  const geoBad = card.location.remoteGeo === "us_only" || card.location.remoteGeo === "eu_only";
  const locUncertain = card.location.confidence < 0.5;
  const locText =
    card.location.mode === "remote"
      ? `Remote · ${card.location.remoteGeo.replace("_", "-")}`
      : `${cap(card.location.mode)}${card.location.label ? ` · ${card.location.label}` : ""}`;
  const exp = expLabel(card.experience);

  return (
    <article className="card" style={{ animationDelay: `${Math.min(index * 28, 600)}ms` }}>
      <div className="gutter">
        <span className={`bar ${band}`} />
        <span className={`score ${band}`}>{card.score}</span>
      </div>

      <div className="body">
        <div className="row1">
          <span className="title">{card.title}</span>
          <a className="company" href={`/company/${card.companyId}`}>
            {card.company}
          </a>
          <span className="dot">·</span>
          <span className="loc">
            {geoBad ? <span className="geo-bad">{locText}</span> : locText}
            {locUncertain && (
              <span className="loc-uncertain" title="Parsed location is low-confidence — verify before applying">
                {" "}· verify?
              </span>
            )}
          </span>
          {card.applied && <span className="applied-badge">✓ in CRM</span>}
        </div>

        <div className="meta">
          <span className="tag fresh">
            <span className="pulse" />
            {card.ageDays <= 0 ? "today" : `${card.ageDays}d`}
          </span>
          {card.atsDirect ? (
            <span className="tag ats">{card.ats} · ATS-direct</span>
          ) : (
            <span className="tag">{card.source}</span>
          )}
          {TIER3.has(card.source) && <span className="tag tier3">tier-3 · local</span>}
          {card.services && <span className="tag" title="IT-services / outsourcing employer">IT services</span>}
          {card.trust < 0.4 && (
            <span className="tag" title="Source trust: source prior × listing signals (agency, gig, re-dated, thin JD…)">
              low trust {Math.round(card.trust * 100)}%
            </span>
          )}
          {exp && (
            <span className="tag exp" data-fit={card.experience.fit ?? undefined} title="Years of experience the JD asks for (parsed) vs yours">
              {exp}
            </span>
          )}
          {card.comp && (
            <span
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
            </span>
          )}
        </div>

        <div className="notes">
          {card.stackNote && (
            <div className="note">
              <span className="k">stack</span>
              <span className={isLangNote(card.stackNote) ? "stack-lang" : ""}>{card.stackNote}</span>
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
            <span className="flag invalid">invalidated · {card.invalidReason}</span>
          </div>
        )}
      </div>

      <div className="actions">
        <span className="arch">{card.archetype.replace(/_/g, "/")}</span>
        <div className="action-btns">
          {onBookmark && (
            <button className="mini" data-on={card.bookmarked} onClick={() => onBookmark(card)} title={card.bookmarked ? "Remove bookmark" : "Bookmark"}>
              {card.bookmarked ? "★ saved" : "☆ save"}
            </button>
          )}
          {onArchive && (
            <button className="mini" onClick={() => onArchive(card)} title={card.archived ? "Unarchive" : "Archive (hide from feed)"}>
              {card.archived ? "⤴ unarchive" : "⤓ archive"}
            </button>
          )}
          {onInvalidate && (
            <button className="mini danger" data-on={card.invalidated} onClick={() => onInvalidate(card)} title={card.invalidated ? "Restore" : "Mark invalid (spam/dupe/fake)"}>
              {card.invalidated ? "↺ restore" : "⊘ invalid"}
            </button>
          )}
          <a className="tailor-link" href={`/tailor/${card.id}`} title="Tailor resume + answers for this role">
            ✎ tailor
          </a>
          {onTrack &&
            (card.applied ? (
              <span className="track tracked">✓ tracked</span>
            ) : (
              <button className="track" onClick={() => onTrack(card)}>
                + track
              </button>
            ))}
          {card.applyUrl ? (
            <a className="apply" href={card.applyUrl} target="_blank" rel="noreferrer">
              Apply →
            </a>
          ) : (
            <span className="apply disabled">no link</span>
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
