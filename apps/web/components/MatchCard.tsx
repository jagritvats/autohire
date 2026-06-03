import type { FeedCard } from "@/lib/feed";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

export function MatchCard({ card, index }: { card: FeedCard; index: number }) {
  const band = card.score >= 78 ? "s-hi" : card.score >= 60 ? "s-mid" : "s-lo";
  const geoBad = card.location.remoteGeo === "us_only" || card.location.remoteGeo === "eu_only";
  const locText =
    card.location.mode === "remote"
      ? `Remote · ${card.location.remoteGeo.replace("_", "-")}`
      : `${cap(card.location.mode)}${card.location.label ? ` · ${card.location.label}` : ""}`;

  return (
    <article className="card" style={{ animationDelay: `${Math.min(index * 28, 600)}ms` }}>
      <div className="gutter">
        <span className={`bar ${band}`} />
        <span className={`score ${band}`}>{card.score}</span>
      </div>

      <div className="body">
        <div className="row1">
          <span className="title">{card.title}</span>
          <span className="company">{card.company}</span>
          <span className="dot">·</span>
          <span className="loc">
            {geoBad ? <span className="geo-bad">{locText}</span> : locText}
          </span>
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
          {card.comp && (
            <span className="tag comp">
              {card.comp.label} <span className="conf">· {card.comp.confidence}</span>
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
      </div>

      <div className="actions">
        <span className="arch">{card.archetype.replace(/_/g, "/")}</span>
        {card.applyUrl ? (
          <a className="apply" href={card.applyUrl} target="_blank" rel="noreferrer">
            Apply →
          </a>
        ) : (
          <span className="apply disabled">no link</span>
        )}
      </div>
    </article>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function isLangNote(note: string) {
  return /primary language/i.test(note);
}
