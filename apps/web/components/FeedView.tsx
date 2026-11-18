"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedCard, FeedData } from "@/lib/feed";
import type { SetupProgress } from "@jobflow/service";
import { MatchCard } from "./MatchCard";
import { Badge, Banner, Button, ButtonLink, Chip, EmptyState, Panel, Segmented, Skeleton, Stat } from "./ui";
import { FilterDrawer } from "./ui/FilterDrawer";
import { roleText } from "@/lib/cardText";
import { todaySummary, type TodaySummary } from "@/lib/today";
import { DIVERSIFY_WINDOW, diversifyByCompany, diversifyKey, moreBelow } from "@jobflow/core";
import { onSyncFinished, startSync, useSyncStatus } from "@/lib/syncClient";
import { runHeadline } from "./SyncDetails";

const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "data_analytics", "sre", "frontend", "mobile"];
const MODES = ["remote", "hybrid", "onsite"];
/** remote-region chips; only the regions present in YOUR jobs are offered (region-neutral). */
const GEOS: Array<{ id: string; label: string }> = [
  { id: "worldwide", label: "anywhere" },
  { id: "india_ok", label: "India OK" },
  { id: "apac_ok", label: "APAC" },
  { id: "us_only", label: "US only" },
  { id: "eu_only", label: "EU only" },
  { id: "country_only", label: "one country only" },
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
  hideAgency: boolean;
  hideUnworkable: boolean;
  minTrust: number;
}
const NO_FILTERS: Filters = { minScore: 0, maxYears: 0, presets: new Set(), roles: new Set(), modes: new Set(), geos: new Set(), hideUsOnly: false, hideServices: false, hideAgency: false, hideUnworkable: false, minTrust: 0 };

/** the FIRST filter that hides a card (so the hidden report adds up), or null */
function hiddenBy(c: FeedCard, f: Filters): string | null {
  if (f.minScore && c.score < f.minScore) return "min score";
  if (f.maxYears > 0 && c.experience.min != null && c.experience.min > f.maxYears) return "years asked"; // unknown YoE is never hidden
  if (f.roles.size && !f.roles.has(c.archetype)) return "role type";
  if (f.presets.size && !(c.presets ?? []).some((p) => f.presets.has(p))) return "preset";
  if (f.modes.size && !f.modes.has(c.location.mode)) return "work mode";
  if (f.geos.size && c.location.mode === "remote" && !f.geos.has(c.location.remoteGeo)) return "remote region";
  if (f.hideUsOnly && c.location.remoteGeo === "us_only") return "US-only remote";
  if (f.hideUnworkable && c.workable === false) return "not workable for you";
  if (f.hideAgency && c.agency) return "staffing agency";
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
  // ordering, not filtering: spread the list across companies (≤3 per 20), or score order only
  const [scoreOrder, setScoreOrder] = useState(false);
  useEffect(() => {
    try {
      setScoreOrder(localStorage.getItem("jobflow.feed.scoreOrder") === "1");
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  const toggleScoreOrder = () =>
    setScoreOrder((on) => {
      try {
        localStorage.setItem("jobflow.feed.scoreOrder", on ? "0" : "1");
      } catch {
        /* storage unavailable: the choice lasts this visit */
      }
      return !on;
    });
  const [notice, setNotice] = useState<string | null>(null);
  // the shared sync watcher (the header indicator's) — a sync started anywhere shows here
  const { status: syncStatus } = useSyncStatus();
  const liveRun = syncStatus?.current ?? null;
  const syncing = syncStatus ? liveRun != null : initial.stats.syncing;
  /** a finished sync's news, offered instead of swapping the list under the reader */
  const [fresh, setFresh] = useState<{ matches: number; jobs: number } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  // the selection only shows (and o/t/a/s/x only act) once the keyboard is in use — a stray
  // key on page load never hides or opens a job the user can't see is selected
  const [kbdActive, setKbdActive] = useState(false);
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
  // then the ORDER: by default no company fills the page (at most 3 in any 20 cards, the
  // rest follow later); scores are untouched and nothing is hidden by it (invariant #4).
  // It runs on what the filters SHOW, so the spread holds for the list on screen.
  const { cards, hidden, more } = useMemo(() => {
    const shown: FeedCard[] = [];
    const by: Record<string, number> = {};
    for (const c of baseCards) {
      const why = hiddenBy(c, filters);
      if (why) by[why] = (by[why] ?? 0) + 1;
      else shown.push(c);
    }
    const spread = !(scored && scoreOrder);
    const ordered = spread ? diversifyByCompany(shown, (c) => diversifyKey(c.company), scored ? { scoreOf: (c) => c.score } : {}) : [...shown].sort((a, b) => b.score - a.score);
    // "+N more at Acme further down" on a company's last card in the first screenful
    const more = spread ? moreBelow(ordered, (c) => diversifyKey(c.company), DIVERSIFY_WINDOW) : new Map<number, number>();
    return { cards: ordered, hidden: by, more };
  }, [baseCards, filters, scored, scoreOrder]);
  const hiddenTotal = Object.values(hidden).reduce((a, b) => a + b, 0);
  const filtersOn = hiddenTotal > 0 || JSON.stringify(filters, (_k, v) => (v instanceof Set ? [...v] : v)) !== JSON.stringify(NO_FILTERS, (_k, v) => (v instanceof Set ? [...v] : v));
  // offer only the chips that can hide something in YOUR jobs (no region-specific defaults)
  const presentGeos = useMemo(() => new Set(baseCards.filter((c) => c.location.mode === "remote").map((c) => c.location.remoteGeo)), [baseCards]);
  const present = useMemo(
    () => ({
      unworkable: baseCards.some((c) => c.workable === false),
      usOnly: baseCards.some((c) => c.location.remoteGeo === "us_only"),
      agency: baseCards.some((c) => c.agency),
      services: baseCards.some((c) => c.services),
    }),
    [baseCards],
  );
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

  // when a sync ends: an empty list fills in by itself (the first sync); a list the person is
  // reading stays put, and the page offers what's new instead ("N new matches — show")
  const shownCount = useRef(0);
  shownCount.current = data.cards.length;
  useEffect(
    () =>
      onSyncFinished(async (run, status) => {
        if (shownCount.current === 0) {
          const { feed } = await reloadFeed();
          if (feed && feed.stats.postings === 0) setSyncError("No jobs came back. The job boards may be unreachable from here (no network, or a proxy blocking them).");
          else flash(`Sync finished — ${feed?.stats.postings ?? 0} jobs in your list.`);
          return;
        }
        const matches = status.you?.ranked ? status.you.newMatches : 0;
        if (matches > 0 || run.postings.new > 0) setFresh({ matches, jobs: run.postings.new });
        else flash("Sync finished — nothing new since your last look.");
        void fetch("/api/progress", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => p && setProgress(p))
          .catch(() => {});
      }),
    [reloadFeed],
  );

  async function showFresh() {
    setFresh(null);
    await reloadFeed();
  }

  async function syncNow() {
    setSyncError(null);
    setFresh(null);
    const err = await startSync();
    if (err) flash(err);
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
      // Enter on a focused button/link belongs to that control; nothing fires under the open filter sheet
      if (e.key === "Enter" && el && (el.tagName === "BUTTON" || el.tagName === "A")) return;
      if (document.documentElement.classList.contains("scroll-locked")) return;
      const card = cards[selected];
      const go = (href: string) => (window.location.href = href);
      if (!kbdActive && e.key.length === 1 && "jkotasx".includes(e.key)) {
        setKbdActive(true); // first key shows the selection on the top card; the next one acts
        return;
      }
      switch (e.key) {
        case "j":
          setSelected((i) => Math.min(cards.length - 1, i + 1));
          break;
        case "k":
          setSelected((i) => Math.max(0, i - 1));
          break;
        case "o":
          if (card) go(`/jobs/${card.id}`);
          break;
        case "Enter":
          if (card && kbdActive) go(`/jobs/${card.id}`);
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
    if (!kbdActive) return;
    document.querySelector(`[data-card-id="${cards[selected]?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, cards, kbdActive]);

  const toggleSet = (key: "presets" | "roles" | "modes" | "geos", v: string) =>
    setFilters((f) => {
      const next = new Set(f[key]);
      next.has(v) ? next.delete(v) : next.add(v);
      return { ...f, [key]: next };
    });

  const tabs: Array<{ tab: Tab; label: string }> = [
    { tab: { kind: "all" }, label: scored ? "All jobs" : "Latest jobs" },
    ...views.map((v) => ({ tab: { kind: "view", id: v.id } as Tab, label: v.name })),
    { tab: { kind: "saved" }, label: "Saved" },
    { tab: { kind: "hidden" }, label: "Hidden" },
  ];
  const corpusEmpty = data.stats.postings === 0;
  // the "today" summary over your whole list (not the current filters): Editorial's lede, Spark's chips
  const today = useMemo(() => todaySummary(data.cards, scored), [data.cards, scored]);
  const dueFollowUps = progress.applications.dueFollowUps;
  const lastSync = progress.corpus.lastSyncAt;
  // how many filters are narrowing the list — shown on the mobile "Filters" button
  const activeFilters =
    filters.presets.size + filters.roles.size + filters.modes.size + filters.geos.size + (filters.minScore > 0 ? 1 : 0) + (filters.maxYears > 0 ? 1 : 0) +
    (filters.hideUsOnly ? 1 : 0) + (filters.hideServices ? 1 : 0) + (filters.hideAgency ? 1 : 0) + (filters.hideUnworkable ? 1 : 0) + (filters.minTrust > 0 ? 1 : 0);
  const tabOptions = tabs.map((t) => ({ id: tabKey(t.tab), label: t.label }));
  const pickTab = (key: string) => {
    const t = tabs.find((x) => tabKey(x.tab) === key);
    if (t) void loadTab(t.tab);
  };

  return (
    <div className="feed-layout">
      <FilterDrawer activeCount={activeFilters}>
        <div className="rail-group">
          <p className="hint">Filters only hide — scores never change, and the count of what's hidden is shown above the list.</p>
          {filtersOn && (
            <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
              clear filters
            </Button>
          )}
        </div>

        {scored && (
          <div className="rail-group">
            <label className="rail-group__label" htmlFor="f-min-score">
              min match <span className="slider-val">{filters.minScore || "any"}</span>
            </label>
            <input
              id="f-min-score"
              type="range"
              min={0}
              max={90}
              step={5}
              value={filters.minScore}
              aria-valuetext={filters.minScore ? `at least ${filters.minScore}` : "any"}
              onChange={(e) => setFilters((f) => ({ ...f, minScore: +e.target.value }))}
            />
          </div>
        )}

        <div className="rail-group">
          <label className="rail-group__label" htmlFor="f-max-years">
            max years asked <span className="slider-val">{filters.maxYears === 0 ? "any" : `≤${filters.maxYears}`}</span>
          </label>
          <input
            id="f-max-years"
            type="range"
            min={0}
            max={15}
            step={1}
            value={filters.maxYears}
            aria-valuetext={filters.maxYears === 0 ? "any" : `at most ${filters.maxYears} years`}
            onChange={(e) => setFilters((f) => ({ ...f, maxYears: +e.target.value }))}
            title="Hide jobs asking for more than N years. Jobs that don't say are kept."
          />
        </div>

        {feedPresets.length > 0 && (
          <fieldset className="rail-group">
            <legend>preset</legend>
            <div className="chip-row">
              {feedPresets.map((p) => (
                <Chip key={p} on={filters.presets.has(p)} onClick={() => toggleSet("presets", p)}>
                  #{p}
                </Chip>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="rail-group">
          <legend>role type</legend>
          <div className="chip-row">
            {ARCHETYPES.map((a) => (
              <Chip key={a} on={filters.roles.has(a)} onClick={() => toggleSet("roles", a)}>
                {roleText(a)}
              </Chip>
            ))}
          </div>
        </fieldset>

        <fieldset className="rail-group">
          <legend>work mode</legend>
          <div className="chip-row">
            {MODES.map((m) => (
              <Chip key={m} on={filters.modes.has(m)} onClick={() => toggleSet("modes", m)}>
                {m}
              </Chip>
            ))}
          </div>
        </fieldset>

        {GEOS.some((g) => presentGeos.has(g.id) || filters.geos.has(g.id)) ? (
        <fieldset className="rail-group">
          <legend>remote from</legend>
          <div className="chip-row">
            {GEOS.filter((g) => presentGeos.has(g.id) || filters.geos.has(g.id)).map((g) => (
              <Chip key={g.id} on={filters.geos.has(g.id)} onClick={() => toggleSet("geos", g.id)}>
                {g.label}
              </Chip>
            ))}
          </div>
        </fieldset>
        ) : null}

        {present.unworkable || present.usOnly || present.agency || present.services || filters.hideUnworkable || filters.hideUsOnly || filters.hideAgency || filters.hideServices ? (
        <fieldset className="rail-group">
          <legend>hide</legend>
          <div className="chip-row">
            {present.unworkable || filters.hideUnworkable ? (
              <Chip on={filters.hideUnworkable} onClick={() => setFilters((f) => ({ ...f, hideUnworkable: !f.hideUnworkable }))} title="Roles outside your home country and markets, or remote only from regions you didn't choose">
                not workable for me
              </Chip>
            ) : null}
            {present.usOnly || filters.hideUsOnly ? (
              <Chip on={filters.hideUsOnly} onClick={() => setFilters((f) => ({ ...f, hideUsOnly: !f.hideUsOnly }))} title="“Remote” roles that are really US-only">
                US-only “remote”
              </Chip>
            ) : null}
            {present.agency || filters.hideAgency ? (
              <Chip on={filters.hideAgency} onClick={() => setFilters((f) => ({ ...f, hideAgency: !f.hideAgency }))} title="Posted by a staffing agency or third-party recruiter, not the employer">
                staffing agencies
              </Chip>
            ) : null}
            {present.services || filters.hideServices ? (
              <Chip on={filters.hideServices} onClick={() => setFilters((f) => ({ ...f, hideServices: !f.hideServices }))} title="IT-services / outsourcing employers">
                IT services firms
              </Chip>
            ) : null}
          </div>
        </fieldset>
        ) : null}

        <div className="rail-group">
          <label className="rail-group__label" htmlFor="f-min-trust">
            min source trust <span className="slider-val">{filters.minTrust === 0 ? "any" : `≥${filters.minTrust}%`}</span>
          </label>
          <input
            id="f-min-trust"
            type="range"
            min={0}
            max={90}
            step={5}
            value={filters.minTrust}
            aria-valuetext={filters.minTrust === 0 ? "any" : `at least ${filters.minTrust} percent`}
            onChange={(e) => setFilters((f) => ({ ...f, minTrust: +e.target.value }))}
            title="How likely a listing is real, still open and answered: employer boards ~85%, re-dating aggregators ~35%, agencies lower"
          />
        </div>

        {scored && (
          <fieldset className="rail-group">
            <legend>order</legend>
            <div className="chip-row">
              <Chip
                on={scoreOrder}
                onClick={toggleScoreOrder}
                title="Off: no company fills the page — at most 3 of its jobs in any 20, the rest follow further down. On: strictly by match score. Scores are the same either way."
              >
                score order only
              </Chip>
            </div>
          </fieldset>
        )}
      </FilterDrawer>

      <div className="feed-main">
        {/* one header, three presentations (lib/style.ts): Editorial's dated masthead + lede,
            Spark's "today" hero with count chips, Classic's title + plain counts */}
        <div className="feed-toolbar feed-hero">
          <div className="feed-toolbar__start">
            <Dateline />
            <p className="feed-hero__eyebrow">Today</p>
            <h1 className="page-title">Jobs</h1>
            <TodayLede today={today} scored={scored} />
            <div className="stats feed-hero__stats" aria-label="Your jobs">
              <Stat className="stat--shown" value={cards.length} label="shown" tone="good" />
              {today.newThisWeek > 0 && <Stat className="feed-hero__extra" value={today.newThisWeek} label="new this week" tone="accent" />}
              {today.great > 0 && <Stat className="feed-hero__extra" value={today.great} label={today.great === 1 ? "great match" : "great matches"} tone="good" />}
              {dueFollowUps > 0 && (
                <a className="stat-link feed-hero__extra" href="/applications" title="Applications with a follow-up date that has come">
                  <Stat value={dueFollowUps} label={dueFollowUps === 1 ? "follow-up due" : "follow-ups due"} tone="warn" />
                </a>
              )}
              <Stat value={data.stats.postings} label="jobs in your list" />
              {data.stats.excluded > 0 && <Stat value={data.stats.excluded} label="left out (pay / location)" tone="muted" />}
            </div>
          </div>
          <div className="feed-toolbar__end">
            {data.stats.demo ? (
              <Badge tone="info" title="Fictional demo data (JOBFLOW_DEMO_DATA=1) — not real postings">
                demo data
              </Badge>
            ) : (
              !data.stats.durable && (
                <Badge tone="warn" title="JOBFLOW_STORE=memory — nothing is saved when the app stops">
                  in-memory: nothing is saved
                </Badge>
              )
            )}
            <span className="hint">{lastSync ? `last sync ${relTime(lastSync)}` : "never synced"}</span>
            <Button icon="refresh" onClick={syncNow} disabled={syncing} title="Fetch new jobs from your sources, then re-rank">
              {syncing ? "syncing…" : "Sync now"}
            </Button>
          </div>
        </div>

        {!progress.complete && !checklistHidden && <SetupChecklist progress={progress} syncing={syncing} onSync={syncNow} onHide={() => setChecklistHidden(true)} />}

        {!scored && !corpusEmpty && (
          <Banner tone="info">
            These are the latest jobs, <b>not scored for you yet</b>. <a href="/onboarding">Add your résumé</a> and JobFlow ranks every one
            against your background, with an honest note on fit and gaps.
          </Banner>
        )}
        {syncing && corpusEmpty && (
          <Banner tone="info" live title="Fetching jobs…">
            {liveRun ? `${runHeadline(liveRun)}. ` : ""}The first sync takes a minute or two — this page updates by itself.
          </Banner>
        )}
        {fresh && !syncing && (
          <Banner
            tone="good"
            live
            title={fresh.matches ? `${fresh.matches} new match${fresh.matches === 1 ? "" : "es"}` : `${fresh.jobs} new job${fresh.jobs === 1 ? "" : "s"}`}
            action={
              <Button size="sm" variant="primary" onClick={showFresh}>
                show
              </Button>
            }
          >
            {fresh.matches ? "The last sync found new jobs that fit you. " : "The last sync added jobs, none above your match line. "}
            Your list stays put until you choose to refresh it.
          </Banner>
        )}
        {syncError && !syncing && (
          <Banner
            tone="bad"
            live
            action={
              <Button size="sm" onClick={syncNow}>
                try again
              </Button>
            }
          >
            {syncError} Check <a href="/sources">Sources</a> for which boards answered, or <a href="/search">search</a> a specific board now.
          </Banner>
        )}
        <StaleBanner lastPolledAt={data.stats.lastPolledAt} onSync={syncNow} syncing={syncing} />

        <div aria-live="polite">
          {notice && (
            <Banner tone="good" className="notice">
              {notice}
            </Banner>
          )}
        </div>

        <div className="feed-summary">
          <div className="feed-tabs">
            <Segmented label="Job lists" value={tabKey(tab)} options={tabOptions} onChange={pickTab} />
            <ButtonLink variant="ghost" size="sm" icon="plus" href="/search" title="Save a search to add it here as a tab">
              view
            </ButtonLink>
          </div>
          <p className="feed-count" aria-live="polite">
            <b>{cards.length}</b> shown
          </p>
        </div>

        {tab.kind === "view" && viewHidden && (
          <p className="ux-hidden-report ux-hidden-report--sentence">
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
            <span>
              <b>{hiddenTotal}</b> hidden by your filters (
              {Object.entries(hidden)
                .map(([k, n]) => `${k} ${n}`)
                .join(", ")}
              )
            </span>
            <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
              clear filters
            </Button>
          </p>
        )}
        {(data.stats.siblingsFolded ?? 0) > 0 && (
          <p className="ux-hidden-report" role="status">
            <span>
              <b>{data.stats.siblingsFolded}</b> more posted for other countries — shown once, under “Also posted for” on their role. Scores are unchanged.
            </span>
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

        {loadingTab ? (
          <div role="status">
            <span className="sr-only">Loading…</span>
            <Skeleton lines={4} />
          </div>
        ) : cards.length === 0 ? (
          <FeedEmpty tab={tab} hiddenTotal={hiddenTotal} corpusEmpty={corpusEmpty} syncing={syncing} scored={scored} onClear={() => setFilters(NO_FILTERS)} onSync={syncNow} />
        ) : (
          <div className="feed">
            {cards.map((c, i) => (
              <MatchCard key={c.id} card={c} index={i} scored={scored} selected={kbdActive && i === selected} onSave={save} onHide={hide} moreAtCompany={more.get(i) ?? 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Today's date over the masthead. Client-only (after mount) so it's the reader's own day. */
function Dateline() {
  const [today, setToday] = useState("");
  useEffect(() => setToday(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })), []);
  return (
    <p className="feed-dateline" aria-hidden={!today || undefined}>
      {today || " "}
    </p>
  );
}

/**
 * The masthead's one-sentence lede: what's new since yesterday (posted in the last day, by the
 * source's own date) and the strongest match. Plain counts only — unscored lists never claim a
 * "best match".
 */
function TodayLede({ today, scored }: { today: TodaySummary & { top: FeedCard | null }; scored: boolean }) {
  const { live, fresh, top } = today;
  if (live === 0) return null;
  const noun = scored ? (fresh === 1 ? "match" : "matches") : fresh === 1 ? "job" : "jobs";
  return (
    <p className="feed-lede">
      {fresh > 0 ? (
        <>
          <b>
            {fresh} new {noun}
          </b>{" "}
          since yesterday.
        </>
      ) : (
        <>Nothing new since yesterday.</>
      )}{" "}
      {top && (
        <>
          The strongest of {live}:{" "}
          <a href={`/jobs/${top.id}`}>
            {top.title}
          </a>{" "}
          at {top.company}, <span className="feed-lede__score">{top.score}</span>.
        </>
      )}
    </p>
  );
}

function SetupChecklist({ progress, syncing, onSync, onHide }: { progress: SetupProgress; syncing: boolean; onSync: () => void; onHide: () => void }) {
  return (
    <Panel
      id="get-started"
      className="ux-setup"
      title={`Get started · ${progress.done}/${progress.total}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onHide} title="Hide until next visit">
          later
        </Button>
      }
    >
      <ol>
        {progress.steps.map((s) => {
          const isNext = progress.next?.id === s.id;
          return (
            <li key={s.id} data-done={s.done} data-next={isNext}>
              <span className="ux-setup__mark" aria-hidden="true">
                {s.done ? "✓" : "○"}
              </span>
              <span className="ux-setup__text">
                <b>{s.title}</b>
                {s.done && <span className="sr-only"> (done)</span>}
                {!s.done && <span className="hint"> {s.detail}</span>}
                {!s.done && <code className="ux-setup__cli">{s.cli}</code>}
              </span>
              {!s.done && isNext && s.id === "sync" ? (
                <Button size="sm" variant="primary" onClick={onSync} disabled={syncing}>
                  {syncing ? "syncing…" : "sync now"}
                </Button>
              ) : (
                !s.done &&
                isNext && (
                  <ButtonLink size="sm" variant="primary" href={s.href}>
                    {s.id === "profile" ? "start" : s.id === "track" ? "pick a job below" : "go"} →
                  </ButtonLink>
                )
              )}
            </li>
          );
        })}
      </ol>
      {!progress.model.configured && (
        <p className="hint">
          Optional: <a href="/settings#model">connect a model</a> for cover letters and written answers. Everything else works offline.
        </p>
      )}
    </Panel>
  );
}

function FeedEmpty({
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
  const syncBtn = (
    <Button size="sm" onClick={onSync} disabled={syncing}>
      sync now
    </Button>
  );
  if (hiddenTotal > 0)
    return (
      <EmptyState
        icon="filter"
        title="Your filters hide everything here"
        action={
          <Button size="sm" onClick={onClear}>
            clear filters
          </Button>
        }
      >
        {hiddenTotal} job{hiddenTotal === 1 ? " is" : "s are"} hidden by your filters. Scores are unchanged.
      </EmptyState>
    );
  if (tab.kind === "saved")
    return (
      <EmptyState icon="bookmark" title="Nothing saved yet">
        Press <b>save</b> on a job (or <kbd>s</kbd>) to keep it here. Saved jobs also appear in <a href="/applications">Applications</a>.
      </EmptyState>
    );
  if (tab.kind === "hidden")
    return (
      <EmptyState icon="archive" title="Nothing hidden">
        Jobs you hide (<b>hide</b>, or <kbd>x</kbd>) move here, out of your way. You can bring them back any time.
      </EmptyState>
    );
  if (tab.kind === "view")
    return (
      <EmptyState title="No jobs match this saved search yet" action={syncBtn}>
        It runs on every sync, so new matches land here. Try <a href="/search">searching live</a> or sync now.
      </EmptyState>
    );
  if (corpusEmpty)
    return (
      <EmptyState
        icon={syncing ? "refresh" : "search"}
        title={syncing ? "Fetching your first jobs…" : "No jobs yet"}
        action={
          syncing ? undefined : (
            <>
              {syncBtn}{" "}
              <ButtonLink size="sm" variant="ghost" href="/search">
                search
              </ButtonLink>
            </>
          )
        }
      >
        {syncing
          ? "Polling the boards in your discovery presets. This takes a minute or two; this page updates by itself."
          : "Fetch jobs from the boards in your presets, or search the live boards right now."}
      </EmptyState>
    );
  return (
    <EmptyState title={scored ? "No ranked jobs yet" : "No jobs to show"} action={syncBtn}>
      {scored ? "JobFlow ranks after each sync." : "Sync to fetch the latest jobs."}
    </EmptyState>
  );
}

/** Jobs are only as current as the last sync — say so when it's been a while. */
function StaleBanner({ lastPolledAt, onSync, syncing }: { lastPolledAt: string | null; onSync: () => void; syncing: boolean }) {
  if (!lastPolledAt || syncing) return null;
  const hours = (Date.now() - new Date(lastPolledAt).getTime()) / 3_600_000;
  if (hours < 24) return null;
  return (
    <Banner
      tone="warn"
      live
      action={
        <Button size="sm" onClick={onSync}>
          sync now
        </Button>
      }
    >
      Last sync was {relTime(lastPolledAt)} — some of these may have closed.
    </Banner>
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
