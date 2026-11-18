"use client";

import "../app/ux.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedCard, FeedData } from "@/lib/feed";
import type { SetupProgress } from "@jobflow/service";
import { MatchCard } from "./MatchCard";
import { SiteNav } from "./AppFrame";
import { roleText } from "@/lib/cardText";

const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "sre", "frontend", "mobile"];
const MODES = ["remote", "hybrid", "onsite"];
const GEOS: Array<{ id: string; label: string }> = [
  { id: "worldwide", label: "anywhere" },
  { id: "india_ok", label: "India OK" },
  { id: "apac_ok", label: "APAC" },
  { id: "us_only", label: "US only" },
  { id: "eu_only", label: "EU only" },
];

/** a tab: the whole ranked list, one of your saved searches, or a collection */
type Tab = { kind: "all" } | { kind: "view"; id: string } | { kind: "saved" } | { kind: "hidden" };
const tabKey = (t: Tab) => (t.kind === "view" ? `view:${t.id}` : t.kind);

interface Filters {
  minScore: number;
  maxYears: number;
  presets: Set<string>;
  roles: Set<string>;
  modes: Set<string>;
  geos: Set<string>;
  hideUsOnly: boolean;
  hideServices: boolean;
  minTrust: number;
}
const NO_FILTERS: Filters = { minScore: 0, maxYears: 0, presets: new Set(), roles: new Set(), modes: new Set(), geos: new Set(), hideUsOnly: false, hideServices: false, minTrust: 0 };

/** the FIRST filter that hides a card (so the hidden report adds up), or null */
function hiddenBy(c: FeedCard, f: Filters): string | null {
  if (f.minScore && c.score < f.minScore) return "min score";
  if (f.maxYears > 0 && c.experience.min != null && c.experience.min > f.maxYears) return "years asked"; // unknown YoE is never hidden
  if (f.roles.size && !f.roles.has(c.archetype)) return "role type";
  if (f.presets.size && !(c.presets ?? []).some((p) => f.presets.has(p))) return "preset";
  if (f.modes.size && !f.modes.has(c.location.mode)) return "work mode";
  if (f.geos.size && c.location.mode === "remote" && !f.geos.has(c.location.remoteGeo)) return "remote region";
  if (f.hideUsOnly && c.location.remoteGeo === "us_only") return "US-only remote";
  if (f.hideServices && c.services) return "IT services";
  if (f.minTrust > 0 && c.trust * 100 < f.minTrust) return "source trust";
  return null;
}

/**
 * Jobs — the daily page. Tabs: all your ranked jobs, each saved search as a view, Saved,
 * Hidden. Filters are VIEWS: they never change a score and the page always says how many
 * jobs they hid and why (invariant #4). A first-run checklist sits on top until the loop
 * is set up; a first sync shows progress and swaps the jobs in by itself.
 * Keys: j/k move · o open · t tailor · a apply · s save · x hide · / search · ? help.
 */
export function FeedView({
  initial,
  initialView = null,
  initialViewData = null,
  views = [],
  progress: initialProgress,
}: {
  initial: FeedData;
  initialView?: string | null;
  /** the saved-search view's cards + hidden counts, when the page opened on one */
  initialViewData?: FeedData | null;
  views?: Array<{ id: string; name: string }>;
  progress: SetupProgress;
}) {
  const [data, setData] = useState(initial);
  const [progress, setProgress] = useState(initialProgress);
  const [tab, setTab] = useState<Tab>(initialView ? { kind: "view", id: initialView } : { kind: "all" });
  const [tabCards, setTabCards] = useState<Record<string, FeedCard[]>>(() => (initialView && initialViewData ? { [`view:${initialView}`]: initialViewData.cards } : {}));
  const [viewHidden, setViewHidden] = useState<{ total: number; by: Record<string, number> } | null>(
    initialViewData ? { total: initialViewData.stats.hiddenTotal ?? 0, by: initialViewData.stats.hidden ?? {} } : null,
  );
  const [loadingTab, setLoadingTab] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(initial.stats.syncing);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [showKeys, setShowKeys] = useState(false);
  const [checklistHidden, setChecklistHidden] = useState(false);

  const scored = data.stats.mode === "ranked";
  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 6000);
  };

  // ── load a tab ──
  const loadTab = useCallback(async (t: Tab) => {
    setTab(t);
    setSelected(0);
    setViewHidden(null);
    if (t.kind === "all") {
      window.history.replaceState(null, "", "/");
      return;
    }
    setLoadingTab(true);
    try {
      const url = t.kind === "view" ? `/api/postings?search=${encodeURIComponent(t.id)}` : `/api/postings?view=${t.kind === "saved" ? "bookmarks" : "archived"}`;
      const r = await fetch(url, { cache: "no-store" });
      const d = r.ok ? await r.json() : { cards: [] };
      setTabCards((s) => ({ ...s, [tabKey(t)]: (d.cards as FeedCard[]) ?? [] }));
      if (t.kind === "view") {
        setViewHidden({ total: d.hiddenTotal ?? 0, by: d.hidden ?? {} });
        window.history.replaceState(null, "", `/?view=${encodeURIComponent(t.id)}`);
      } else window.history.replaceState(null, "", "/");
    } finally {
      setLoadingTab(false);
    }
  }, []);

  const baseCards = tab.kind === "all" ? data.cards : tabCards[tabKey(tab)] ?? [];

  // ── filters as a view: count what they hide, per reason ──
  const { cards, hidden } = useMemo(() => {
    const shown: FeedCard[] = [];
    const by: Record<string, number> = {};
    for (const c of baseCards) {
      const why = hiddenBy(c, filters);
      if (why) by[why] = (by[why] ?? 0) + 1;
      else shown.push(c);
    }
    return { cards: shown, hidden: by };
  }, [baseCards, filters]);
  const hiddenTotal = Object.values(hidden).reduce((a, b) => a + b, 0);
  const filtersOn = hiddenTotal > 0 || JSON.stringify(filters, (_k, v) => (v instanceof Set ? [...v] : v)) !== JSON.stringify(NO_FILTERS, (_k, v) => (v instanceof Set ? [...v] : v));
  const feedPresets = useMemo(() => [...new Set(baseCards.flatMap((c) => c.presets ?? []))].sort(), [baseCards]);

  // ── sync: start in the background, poll progress, swap the jobs in when done ──
  const reloadFeed = useCallback(async () => {
    const [f, p] = await Promise.all([
      fetch("/api/postings?view=feed", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/progress", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (f) setData(f);
    if (p) setProgress(p);
    return { feed: f as FeedData | null, progress: p as SetupProgress | null };
  }, []);

  useEffect(() => {
    if (!syncing) return;
    let stop = false;
    const tick = async () => {
      const p = (await fetch("/api/progress", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as SetupProgress | null;
      if (stop || !p) return;
      setProgress(p);
      if (!p.corpus.syncing) {
        setSyncing(false);
        const { feed } = await reloadFeed();
        if (feed && feed.stats.postings === 0) setSyncError("No jobs came back. The job boards may be unreachable from here (no network, or a proxy blocking them).");
        else flash(`Sync finished — ${feed?.stats.postings ?? p.corpus.postings} jobs in your list.`);
      }
    };
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [syncing, reloadFeed]);

  async function syncNow() {
    setSyncError(null);
    const r = await fetch("/api/refresh?background=1", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(d.error ?? "Couldn't start a sync.");
    setSyncing(true);
  }

  // ── card actions ──
  const send = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const patchCard = (id: string, fn: (c: FeedCard) => FeedCard) => {
    setData((d) => ({ ...d, cards: d.cards.map((c) => (c.id === id ? fn(c) : c)) }));
    setTabCards((s) => Object.fromEntries(Object.entries(s).map(([k, list]) => [k, list.map((c) => (c.id === id ? fn(c) : c))])));
  };
  const dropCard = (id: string, from: "list" | "hidden" | "saved") => {
    if (from === "list") {
      setData((d) => ({ ...d, cards: d.cards.filter((c) => c.id !== id) }));
      setTabCards((s) => Object.fromEntries(Object.entries(s).map(([k, list]) => [k, k.startsWith("view:") ? list.filter((c) => c.id !== id) : list])));
    } else setTabCards((s) => ({ ...s, [from]: (s[from] ?? []).filter((c) => c.id !== id) }));
  };

  async function save(card: FeedCard) {
    const next = !card.bookmarked;
    patchCard(card.id, (c) => ({ ...c, bookmarked: next, applied: next ? true : c.applied }));
    if (tab.kind === "saved" && !next) dropCard(card.id, "saved");
    await send("/api/postings/bookmark", { postingId: card.id }, next ? "POST" : "DELETE");
    if (next && !card.applied) {
      await send("/api/applications", { postingId: card.id, status: "saved" });
      flash(`Saved “${card.title}” — it's in Applications as Saved.`);
      setProgress((p) => ({ ...p, steps: p.steps.map((s) => (s.id === "track" ? { ...s, done: true } : s)) }));
    }
  }

  async function hide(card: FeedCard) {
    const next = !card.archived;
    await send("/api/postings/archive", { postingId: card.id }, next ? "POST" : "DELETE");
    if (next) {
      dropCard(card.id, "list");
      flash(`Hidden “${card.title}”. It's under the Hidden tab if you change your mind.`);
    } else {
      dropCard(card.id, "hidden");
      flash(`“${card.title}” is back in your jobs.`);
    }
  }

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const card = cards[selected];
      const go = (href: string) => (window.location.href = href);
      switch (e.key) {
        case "j":
          setSelected((i) => Math.min(cards.length - 1, i + 1));
          break;
        case "k":
          setSelected((i) => Math.max(0, i - 1));
          break;
        case "o":
        case "Enter":
          if (card) go(`/jobs/${card.id}`);
          break;
        case "t":
          if (card) go(`/tailor/${card.id}`);
          break;
        case "a":
          if (card) go(`/jobs/${card.id}#apply`);
          break;
        case "s":
          if (card) void save(card);
          break;
        case "x":
          if (card) void hide(card);
          break;
        case "/":
          e.preventDefault();
          go("/search");
          break;
        case "?":
          setShowKeys((v) => !v);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    document.querySelector(`[data-card-id="${cards[selected]?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, cards]);

  const toggleSet = (key: "presets" | "roles" | "modes" | "geos", v: string) =>
    setFilters((f) => {
      const next = new Set(f[key]);
      next.has(v) ? next.delete(v) : next.add(v);
      return { ...f, [key]: next };
    });

  const tabs: Array<{ tab: Tab; label: string }> = [
    { tab: { kind: "all" }, label: scored ? "All jobs" : "Latest jobs" },
    ...views.map((v) => ({ tab: { kind: "view", id: v.id } as Tab, label: v.name })),
    { tab: { kind: "saved" }, label: "★ Saved" },
    { tab: { kind: "hidden" }, label: "Hidden" },
  ];
  const corpusEmpty = data.stats.postings === 0;
  const lastSync = progress.corpus.lastSyncAt;

  return (
    <div className="shell">
      <aside className="rail">
        <a href="/" className="wordmark" aria-label="JobFlow home">
          Job<span className="flow">Flow</span>
        </a>
        <SiteNav />

        <div className="rail-group">
          <h4>
            filter{" "}
            {filtersOn && (
              <button type="button" className="chip" onClick={() => setFilters(NO_FILTERS)}>
                clear
              </button>
            )}
          </h4>
          <p className="hint">Filters only hide — scores never change, and the count of what's hidden is shown above the list.</p>
        </div>

        {scored && (
          <div className="rail-group">
            <h4>
              min match <span className="slider-val">{filters.minScore || "any"}</span>
            </h4>
            <input type="range" min={0} max={90} step={5} value={filters.minScore} onChange={(e) => setFilters((f) => ({ ...f, minScore: +e.target.value }))} aria-label="Minimum match score" />
          </div>
        )}

        <div className="rail-group">
          <h4>
            max years asked <span className="slider-val">{filters.maxYears === 0 ? "any" : `≤${filters.maxYears}`}</span>
          </h4>
          <input
            type="range"
            min={0}
            max={15}
            step={1}
            value={filters.maxYears}
            onChange={(e) => setFilters((f) => ({ ...f, maxYears: +e.target.value }))}
            aria-label="Maximum years of experience the job asks for"
            title="Hide jobs asking for more than N years. Jobs that don't say are kept."
          />
        </div>

        {feedPresets.length > 0 && (
          <div className="rail-group">
            <h4>preset</h4>
            <div className="chip-row">
              {feedPresets.map((p) => (
                <button key={p} className="chip" data-on={filters.presets.has(p)} onClick={() => toggleSet("presets", p)}>
                  #{p}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rail-group">
          <h4>role type</h4>
          <div className="chip-row">
            {ARCHETYPES.map((a) => (
              <button key={a} className="chip" data-on={filters.roles.has(a)} onClick={() => toggleSet("roles", a)}>
                {roleText(a)}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>work mode</h4>
          <div className="chip-row">
            {MODES.map((m) => (
              <button key={m} className="chip" data-on={filters.modes.has(m)} onClick={() => toggleSet("modes", m)}>
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>remote from</h4>
          <div className="chip-row">
            {GEOS.map((g) => (
              <button key={g.id} className="chip" data-on={filters.geos.has(g.id)} onClick={() => toggleSet("geos", g.id)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rail-group">
          <h4>hide</h4>
          <div className="chip-row">
            <button className="chip" data-on={filters.hideUsOnly} onClick={() => setFilters((f) => ({ ...f, hideUsOnly: !f.hideUsOnly }))} title="“Remote” roles that are really US-only">
              US-only “remote”
            </button>
            <button className="chip" data-on={filters.hideServices} onClick={() => setFilters((f) => ({ ...f, hideServices: !f.hideServices }))} title="IT-services / outsourcing employers">
              IT services firms
            </button>
          </div>
        </div>

        <div className="rail-group">
          <h4>
            min source trust <span className="slider-val">{filters.minTrust === 0 ? "any" : `≥${filters.minTrust}%`}</span>
          </h4>
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={filters.minTrust}
            onChange={(e) => setFilters((f) => ({ ...f, minTrust: +e.target.value }))}
            aria-label="Minimum source trust"
            title="How likely a listing is real, still open and answered: employer boards ~85%, re-dating aggregators ~35%, agencies lower"
          />
        </div>
      </aside>

      <main className="main">
        {!progress.complete && !checklistHidden && <SetupChecklist progress={progress} syncing={syncing} onSync={syncNow} onHide={() => setChecklistHidden(true)} />}

        {!scored && !corpusEmpty && (
          <div className="feed-banner">
            These are the latest jobs, <b>not scored for you yet</b>. <a href="/onboarding">Add your résumé</a> and JobFlow ranks every one
            against your background, with an honest note on fit and gaps.
          </div>
        )}
        {syncing && (
          <div className="feed-banner" role="status" aria-live="polite">
            <b>Fetching jobs…</b> polling the boards in your presets. The first sync takes a minute or two — this page updates by itself.
          </div>
        )}
        {syncError && !syncing && (
          <div className="stale-banner" role="alert">
            {syncError}{" "}
            <button type="button" className="chip" onClick={syncNow}>
              try again
            </button>{" "}
            · check <a href="/sources">Sources</a> for which boards answered · or <a href="/search">search</a> a specific board now.
          </div>
        )}
        <StaleBanner lastPolledAt={data.stats.lastPolledAt} onSync={syncNow} syncing={syncing} />

        <div className="statsbar">
          <Stat n={cards.length} l="shown" good />
          <Stat n={data.stats.postings} l="jobs in your list" muted />
          <span className="hint" style={{ alignSelf: "center" }}>
            {lastSync ? `last sync ${relTime(lastSync)}` : "never synced"}
          </span>
          <button className="refresh" onClick={syncNow} disabled={syncing} title="Fetch new jobs from your sources, then re-rank">
            {syncing ? "syncing…" : "↻ Sync now"}
          </button>
        </div>

        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}

        <div className="view-tabs" role="tablist" aria-label="Job lists">
          {tabs.map((t) => (
            <button key={tabKey(t.tab)} role="tab" className="view-tab" aria-selected={tabKey(t.tab) === tabKey(tab)} data-on={tabKey(t.tab) === tabKey(tab)} onClick={() => void loadTab(t.tab)}>
              {t.label}
            </button>
          ))}
          <a className="view-tab" href="/search" title="Save a search to add it here as a tab">
            + view
          </a>
        </div>

        {tab.kind === "view" && viewHidden && (
          <p className="ux-hidden-report">
            Through your saved search <b>{views.find((v) => v.id === tab.id)?.name}</b>
            {viewHidden.total > 0
              ? ` — it hides ${viewHidden.total} (${Object.entries(viewHidden.by)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${k} ${n}`)
                  .join(", ")})`
              : " — it hides nothing here"}
            . Scores are unchanged.
          </p>
        )}
        {hiddenTotal > 0 && (
          <p className="ux-hidden-report" role="status">
            {hiddenTotal} hidden by your filters (
            {Object.entries(hidden)
              .map(([k, n]) => `${k} ${n}`)
              .join(", ")}
            )
            <button type="button" className="chip" onClick={() => setFilters(NO_FILTERS)}>
              clear filters
            </button>
          </p>
        )}
        {cards.length > 0 && (
          <p className="ux-kbd">
            {showKeys ? (
              <>
                <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>o</kbd> open · <kbd>t</kbd> tailor · <kbd>a</kbd> apply · <kbd>s</kbd> save · <kbd>x</kbd> hide ·{" "}
                <kbd>/</kbd> search · <kbd>?</kbd> close
              </>
            ) : (
              <>
                Press <kbd>?</kbd> for keyboard shortcuts.
              </>
            )}
          </p>
        )}

        <div className="feed">
          {loadingTab ? (
            <div className="feed-empty">Loading…</div>
          ) : cards.length === 0 ? (
            <EmptyState tab={tab} hiddenTotal={hiddenTotal} corpusEmpty={corpusEmpty} syncing={syncing} scored={scored} onClear={() => setFilters(NO_FILTERS)} onSync={syncNow} />
          ) : (
            cards.map((c, i) => (
              <MatchCard key={c.id} card={c} index={i} scored={scored} selected={i === selected} onSave={save} onHide={hide} />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function SetupChecklist({ progress, syncing, onSync, onHide }: { progress: SetupProgress; syncing: boolean; onSync: () => void; onHide: () => void }) {
  return (
    <section className="ux-setup" aria-label="Get started">
      <h2>
        Get started · {progress.done}/{progress.total}{" "}
        <button type="button" className="chip" onClick={onHide} title="Hide until next visit">
          later
        </button>
      </h2>
      <ol>
        {progress.steps.map((s) => {
          const isNext = progress.next?.id === s.id;
          return (
            <li key={s.id} data-done={s.done} data-next={isNext}>
              <span>{s.done ? "✓" : "○"}</span>
              <b>{s.title}</b>
              {!s.done && <span className="hint">{s.detail}</span>}
              {!s.done && isNext && s.id === "sync" ? (
                <button type="button" className="chip" onClick={onSync} disabled={syncing}>
                  {syncing ? "syncing…" : "sync now"}
                </button>
              ) : (
                !s.done && isNext && (
                  <a className="chip" href={s.href}>
                    {s.id === "profile" ? "start" : s.id === "track" ? "pick a job below" : "go"} →
                  </a>
                )
              )}
              {!s.done && <code className="hint">{s.cli}</code>}
            </li>
          );
        })}
      </ol>
      {!progress.model.configured && (
        <p className="hint">
          Optional: <a href="/settings#model">connect a model</a> for cover letters and written answers. Everything else works offline.
        </p>
      )}
    </section>
  );
}

function EmptyState({
  tab,
  hiddenTotal,
  corpusEmpty,
  syncing,
  scored,
  onClear,
  onSync,
}: {
  tab: Tab;
  hiddenTotal: number;
  corpusEmpty: boolean;
  syncing: boolean;
  scored: boolean;
  onClear: () => void;
  onSync: () => void;
}) {
  if (hiddenTotal > 0)
    return (
      <div className="ux-empty">
        <h2>Your filters hide everything here</h2>
        {hiddenTotal} job{hiddenTotal === 1 ? " is" : "s are"} hidden by the filters on the left.{" "}
        <button type="button" className="chip" onClick={onClear}>
          clear filters
        </button>
      </div>
    );
  if (tab.kind === "saved")
    return (
      <div className="ux-empty">
        <h2>Nothing saved yet</h2>
        Press <b>☆ save</b> on a job (or <kbd>s</kbd>) to keep it here. Saved jobs also appear in <a href="/applications">Applications</a>.
      </div>
    );
  if (tab.kind === "hidden")
    return (
      <div className="ux-empty">
        <h2>Nothing hidden</h2>
        Jobs you hide (<b>hide</b>, or <kbd>x</kbd>) move here, out of your way. You can bring them back any time.
      </div>
    );
  if (tab.kind === "view")
    return (
      <div className="ux-empty">
        <h2>No jobs match this saved search yet</h2>
        It runs on every sync, so new matches land here. Try <a href="/search">searching live</a> or <button type="button" className="chip" onClick={onSync}>sync now</button>.
      </div>
    );
  if (corpusEmpty)
    return (
      <div className="ux-empty">
        <h2>{syncing ? "Fetching your first jobs…" : "No jobs yet"}</h2>
        {syncing ? (
          "Polling the boards in your discovery presets. This takes a minute or two; this page updates by itself."
        ) : (
          <>
            Fetch jobs from the boards in your presets, or search the live boards right now.{" "}
            <button type="button" className="chip" onClick={onSync}>
              sync now
            </button>{" "}
            <a className="chip" href="/search">
              search
            </a>
          </>
        )}
      </div>
    );
  return (
    <div className="ux-empty">
      <h2>{scored ? "No ranked jobs yet" : "No jobs to show"}</h2>
      {scored ? (
        <>
          JobFlow ranks after each sync.{" "}
          <button type="button" className="chip" onClick={onSync}>
            sync now
          </button>
        </>
      ) : (
        "Sync to fetch the latest jobs."
      )}
    </div>
  );
}

/** Jobs are only as current as the last sync — say so when it's been a while. */
function StaleBanner({ lastPolledAt, onSync, syncing }: { lastPolledAt: string | null; onSync: () => void; syncing: boolean }) {
  if (!lastPolledAt || syncing) return null;
  const hours = (Date.now() - new Date(lastPolledAt).getTime()) / 3_600_000;
  if (hours < 24) return null;
  return (
    <div className="stale-banner" role="status">
      Last sync was {relTime(lastPolledAt)} — some of these may have closed.{" "}
      <button type="button" className="chip" onClick={onSync}>
        sync now
      </button>
    </div>
  );
}

function relTime(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 2) return "just now";
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const h = mins / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function Stat({ n, l, good, muted }: { n: number; l: string; good?: boolean; muted?: boolean }) {
  return (
    <div className="stat">
      <div className={`n ${good ? "good" : muted ? "muted" : ""}`}>{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}
