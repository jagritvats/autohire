"use client";

import { AccountMenu } from "@/components/AccountMenu";
import { useMemo, useState, useTransition } from "react";
import type { FeedCard, FeedData, PostingView } from "@/lib/feed";
import { MatchCard } from "./MatchCard";
import { ActivityPanel } from "./ActivityPanel";

const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "sre", "frontend"];
const MODES = ["remote", "hybrid", "onsite"];
const GEOS = ["worldwide", "india_ok", "apac_ok", "us_only", "eu_only"];

type ActiveView = "feed" | PostingView;
const VIEW_TABS: Array<{ id: ActiveView; label: string }> = [
  { id: "feed", label: "feed" },
  { id: "bookmarks", label: "★ bookmarks" },
  { id: "archived", label: "archived" },
  { id: "invalidated", label: "invalidated" },
];

const emptyViews: Record<PostingView, FeedCard[]> = { bookmarks: [], archived: [], invalidated: [] };

export function FeedView({ initial, viewName = null }: { initial: FeedData; viewName?: string | null }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<ActiveView>("feed");
  const [viewData, setViewData] = useState<Record<PostingView, FeedCard[]>>(emptyViews);
  const [loadingView, setLoadingView] = useState(false);
  const [arch, setArch] = useState<Set<string>>(new Set());
  const [modes, setModes] = useState<Set<string>>(new Set());
  const [geos, setGeos] = useState<Set<string>>(new Set());
  const [presetTags, setPresetTags] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [maxYears, setMaxYears] = useState(0); // 0 = any; caps the role's minimum required YoE
  const [hideUsOnly, setHideUsOnly] = useState(false);
  const [hideServices, setHideServices] = useState(false);
  const [minTrust, setMinTrust] = useState(0); // 0..90 (%), source trust floor
  // India-onsite "allowed" view filter — server-fetched (UI → api → feed → query).
  const [indiaOnly, setIndiaOnly] = useState(false);
  const [indiaCards, setIndiaCards] = useState<FeedCard[] | null>(null);
  const [indiaLoading, setIndiaLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    fn(next);
  };

  // `?? []` guards against a momentarily-undefined server payload (e.g. a slow/empty
  // fetch, or a shape mismatch during dev-server reloads) — never crash the whole view.
  const baseCards =
    (view === "feed" ? (indiaOnly ? (indiaCards ?? []) : data.cards) : viewData[view]) ?? [];

  const cards = useMemo(() => {
    return baseCards.filter((c) => {
      if (c.score < minScore) return false;
      // max-years cap: hide roles whose stated MINIMUM YoE exceeds the cap. Roles with no
      // parsed minimum (min === null) are always kept — never hide on unknown (§11, invariant #4).
      if (maxYears > 0 && c.experience.min != null && c.experience.min > maxYears) return false;
      if (arch.size && !arch.has(c.archetype)) return false;
      // preset TAG filter: only cards from the chosen presets' companies / feeds
      if (presetTags.size && !(c.presets ?? []).some((p) => presetTags.has(p))) return false;
      if (modes.size && !modes.has(c.location.mode)) return false;
      if (geos.size && c.location.mode === "remote" && !geos.has(c.location.remoteGeo)) return false;
      if (hideUsOnly && c.location.remoteGeo === "us_only") return false;
      if (hideServices && c.services) return false;
      if (minTrust > 0 && c.trust * 100 < minTrust) return false;
      return true;
    });
  }, [baseCards, arch, modes, geos, presetTags, minScore, maxYears, hideUsOnly, hideServices, minTrust]);
  // the preset tags present in this feed (only offer filters that can match something)
  const feedPresets = useMemo(() => [...new Set(baseCards.flatMap((c) => c.presets ?? []))].sort(), [baseCards]);

  // India-onsite "allowed" filter: fetch the India-workable feed on first toggle-on.
  const toggleIndia = () => {
    const next = !indiaOnly;
    setIndiaOnly(next);
    if (next) setView("feed");
    if (next && indiaCards === null) {
      setIndiaLoading(true);
      fetch("/api/postings?india=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { cards: [] }))
        .then((d) => setIndiaCards((d.cards as FeedCard[]) ?? []))
        .catch(() => setIndiaCards([]))
        .finally(() => setIndiaLoading(false));
    }
  };

  // ── mutation plumbing ──
  const jreq = (url: string, body: unknown, method = "POST") =>
    fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const patchCard = (id: string, fn: (c: FeedCard) => FeedCard) => {
    setData((d) => ({ ...d, cards: d.cards.map((c) => (c.id === id ? fn(c) : c)) }));
    setViewData((s) => {
      const out = { ...s };
      (Object.keys(out) as PostingView[]).forEach((k) => (out[k] = out[k].map((c) => (c.id === id ? fn(c) : c))));
      return out;
    });
  };
  const dropFromFeed = (id: string) => setData((d) => ({ ...d, cards: d.cards.filter((c) => c.id !== id) }));
  const dropFromView = (v: PostingView, id: string) =>
    setViewData((s) => ({ ...s, [v]: s[v].filter((c) => c.id !== id) }));

  const loadView = async (v: PostingView) => {
    setLoadingView(true);
    try {
      const res = await fetch(`/api/postings?view=${v}`, { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        setViewData((s) => ({ ...s, [v]: d.cards as FeedCard[] }));
      }
    } finally {
      setLoadingView(false);
    }
  };
  const selectView = (v: ActiveView) => {
    setView(v);
    if (v !== "feed") loadView(v);
  };

  const flashNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 7000);
  };

  const refresh = () => {
    startTransition(async () => {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (res.ok) {
        setData(await res.json());
        setView("feed");
        setIndiaCards(null); // invalidate the cached India-workable slice
      }
    });
  };

  // recheck/purge now ENQUEUE cloud jobs (→ { queued, job }); they no longer return a
  // fresh feed. Surface a "queued" notice and let the Activity panel show progress.
  const recheck = () => {
    startTransition(async () => {
      const res = await jreq("/api/postings/recheck", {});
      const d = await res.json().catch(() => ({}));
      flashNotice(
        res.ok && d?.queued
          ? "Recheck queued — watch the Activity panel."
          : res.ok
            ? "Recheck requested."
            : "Recheck failed to queue.",
      );
    });
  };

  const purge = () => {
    const raw = window.prompt("Soft-delete (mark stale) postings not seen in the last N days:", "30");
    const days = Number(raw);
    if (!raw || !Number.isFinite(days) || days <= 0) return;
    startTransition(async () => {
      const res = await jreq("/api/postings/purge", { olderThanDays: days, field: "lastSeen" });
      const d = await res.json().catch(() => ({}));
      flashNotice(
        res.ok && d?.queued
          ? "Remove-old queued — watch the Activity panel."
          : res.ok
            ? "Remove-old requested."
            : "Remove-old failed to queue.",
      );
    });
  };

  const track = async (card: FeedCard) => {
    patchCard(card.id, (c) => ({ ...c, applied: true }));
    setData((d) => ({
      ...d,
      cards: d.cards.map((c) => (c.companyId === card.companyId && c.title === card.title ? { ...c, applied: true } : c)),
    }));
    await jreq("/api/applications", { postingId: card.id, status: "saved" });
  };

  const bookmark = async (card: FeedCard) => {
    const next = !card.bookmarked;
    patchCard(card.id, (c) => ({ ...c, bookmarked: next }));
    if (view === "bookmarks" && !next) dropFromView("bookmarks", card.id);
    await jreq("/api/postings/bookmark", { postingId: card.id }, next ? "POST" : "DELETE");
  };

  const archive = async (card: FeedCard) => {
    const next = !card.archived;
    await jreq("/api/postings/archive", { postingId: card.id }, next ? "POST" : "DELETE");
    if (next && view === "feed") dropFromFeed(card.id);
    else if (!next && view === "archived") dropFromView("archived", card.id);
    else patchCard(card.id, (c) => ({ ...c, archived: next }));
  };

  const invalidate = async (card: FeedCard) => {
    const next = !card.invalidated;
    let reason: string | undefined;
    if (next) {
      const r = window.prompt("Reason for marking this posting invalid?", "not relevant");
      if (r === null) return; // cancelled
      reason = r.trim() || "marked invalid";
    }
    await jreq("/api/postings/invalidate", { postingId: card.id, reason }, next ? "POST" : "DELETE");
    if (next && view === "feed") dropFromFeed(card.id);
    else if (!next && view === "invalidated") dropFromView("invalidated", card.id);
    else patchCard(card.id, (c) => ({ ...c, invalidated: next, invalidReason: next ? reason ?? null : null }));
  };

  const emptyMsg =
    view === "feed"
      ? indiaOnly && indiaLoading
        ? "Loading India-workable roles…"
        : indiaOnly
          ? "No India-workable roles under these filters."
          : "No matches under these filters."
      : loadingView
        ? "Loading…"
        : `No ${view} yet.`;

  return (
    <div className="shell">
      <aside className="rail">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span>
        </h1>
        <div className="tagline">ranked match feed</div>
        <nav className="rail-nav">
          <a href="/" data-active="true">feed</a>
          <a href="/searches">search</a>
          <a href="/discovery">discovery</a>
          <a href="/applications">pipeline</a>
          <a href="/companies">registry</a>
          <a href="/settings">settings</a>
          <AccountMenu />
          <span className="durable-pill" data-on={data.stats.durable}>
            {data.stats.durable ? "durable" : "in-memory"}
          </span>
        </nav>

        <div className="rail-group">
          <h4>
            min score <span className="slider-val">{minScore}</span>
          </h4>
          <input type="range" min={0} max={90} step={5} value={minScore} onChange={(e) => setMinScore(+e.target.value)} />
        </div>

        <div className="rail-group">
          <h4>
            max years exp <span className="slider-val">{maxYears === 0 ? "any" : `≤${maxYears}y`}</span>
          </h4>
          <input
            type="range"
            min={0}
            max={15}
            step={1}
            value={maxYears}
            onChange={(e) => setMaxYears(+e.target.value)}
            title="Hide roles asking for more than N years of experience. Roles with no stated minimum are kept."
          />
        </div>

        {feedPresets.length > 0 && (
          <div className="rail-group">
            <h4>preset</h4>
            <div className="chip-row">
              {feedPresets.map((p) => (
                <button key={p} className="chip" data-on={presetTags.has(p)} onClick={() => toggle(presetTags, p, setPresetTags)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rail-group">
          <h4>archetype</h4>
          <div className="chip-row">
            {ARCHETYPES.map((a) => (
              <button key={a} className="chip" data-on={arch.has(a)} onClick={() => toggle(arch, a, setArch)}>
                {a.replace(/_/g, "/")}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>work mode</h4>
          <div className="chip-row">
            {MODES.map((m) => (
              <button key={m} className="chip" data-on={modes.has(m)} onClick={() => toggle(modes, m, setModes)}>
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>remote geo</h4>
          <div className="chip-row">
            {GEOS.map((g) => (
              <button key={g} className="chip" data-on={geos.has(g)} onClick={() => toggle(geos, g, setGeos)}>
                {g.replace(/_/g, "-")}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>region</h4>
          <div className="chip-row">
            <button
              className="chip"
              data-on={indiaOnly}
              onClick={toggleIndia}
              disabled={indiaLoading}
              title="Show only India-workable roles (onsite/hybrid in India, or India-ok / worldwide remote)"
            >
              {indiaLoading ? "loading…" : "india-onsite allowed"}
            </button>
          </div>
        </div>

        <div className="rail-group">
          <h4>honesty</h4>
          <div className="chip-row">
            <button className="chip" data-on={hideUsOnly} onClick={() => setHideUsOnly((v) => !v)}>
              hide us-only “remote”
            </button>
            <button
              className="chip"
              data-on={hideServices}
              onClick={() => setHideServices((v) => !v)}
              title="Hide IT-services / outsourcing employers (companies tagged 'services')"
            >
              hide IT services
            </button>
          </div>
        </div>

        <div className="rail-group">
          <h4>
            min source trust <span className="slider-val">{minTrust === 0 ? "any" : `≥${minTrust}%`}</span>
          </h4>
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={minTrust}
            onChange={(e) => setMinTrust(+e.target.value)}
            title="Source trust: how likely a listing is real, still open and answered (ATS boards ~85%, re-dating aggregators ~35%, gigs and agency posts lower)"
          />
        </div>

        <div className="rail-group">
          <h4>maintenance</h4>
          <div className="chip-row">
            <button className="chip" onClick={recheck} disabled={pending} title="Re-poll active boards to verify freshness">
              recheck all
            </button>
            <button className="chip" onClick={purge} disabled={pending} title="Soft-delete postings older than a threshold">
              remove old
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {data.stats.needsOnboarding && (
          <div className="feed-banner">
            These are the freshest postings, <b>unscored</b>. <a href="/onboarding">Add your résumé</a> to get ranked,
            honest match cards.
          </div>
        )}
        {viewName && (
          <div className="feed-banner">
            Viewing your feed through the saved search <b>{viewName}</b>
            {data.stats.hiddenTotal ? (
              <>
                {" "}— {data.stats.hiddenTotal} hidden (
                {Object.entries(data.stats.hidden ?? {})
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(", ")}
                ).
              </>
            ) : (
              "."
            )}{" "}
            Scores are unchanged. <a href="/">show all</a>
          </div>
        )}
        {data.stats.syncing && (
          <div className="feed-banner">Fetching jobs from the built-in sources for the first time — refresh in a minute.</div>
        )}
        <div className="statsbar">
          <Stat n={data.stats.companies} l="companies" />
          <Stat n={data.stats.postings} l="active postings" />
          <Stat n={data.stats.ranked} l="ranked" good />
          <Stat n={data.stats.excluded} l="hard-excluded" muted />
          <Stat n={cards.length} l="shown" />
          <button className="refresh" onClick={refresh} disabled={pending}>
            {pending ? "polling…" : "↻ sync re-poll"}
          </button>
        </div>

        <StaleBanner lastPolledAt={data.stats.lastPolledAt} />

        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}

        <ActivityPanel />

        <div className="view-tabs">
          {VIEW_TABS.map((t) => (
            <button key={t.id} className="view-tab" data-on={view === t.id} onClick={() => selectView(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="feed">
          {cards.length === 0 ? (
            <div className="feed-empty">{emptyMsg}</div>
          ) : (
            cards.map((c, i) => (
              <MatchCard
                key={c.id}
                card={c}
                index={i}
                onTrack={track}
                onBookmark={bookmark}
                onArchive={archive}
                onInvalidate={invalidate}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

/** Postings are only as current as the last poll — say so when it's been a while (§3). */
function StaleBanner({ lastPolledAt }: { lastPolledAt: string | null }) {
  if (!lastPolledAt) return null;
  const hours = (Date.now() - new Date(lastPolledAt).getTime()) / 3_600_000;
  if (hours < 24) return null;
  const ago = hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
  return (
    <div className="stale-banner" role="status">
      Last poll was {ago} ago — listings are unverified and may be closed. Keep the worker runner up (it
      re-polls every few hours) or use ↻ sync re-poll.
    </div>
  );
}

function Stat({ n, l, good, muted }: { n: number; l: string; good?: boolean; muted?: boolean }) {
  return (
    <div className="stat">
      <div className={`n ${good ? "good" : muted ? "muted" : ""}`}>{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}
