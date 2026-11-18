"use client";

import { useEffect, useState } from "react";
import type { FeedCard } from "@/lib/feed";
import { MatchCard } from "./MatchCard";
import { Banner, Button, ButtonLink, Chip, EmptyState, Skeleton } from "./ui";

/** click-to-run examples — the query syntax is the CLI's, so they double as a tutorial */
const EXAMPLES = [
  "backend engineer --remote",
  '"data engineer" --loc Berlin,DE --posted 7d',
  "platform --seniority senior,staff",
  "golang --must kafka --remote",
  "frontend --min-salary 120k USD",
];

const SYNTAX: Array<[string, string]> = [
  ["words", "what the job is about — any of them; quote a phrase: \"site reliability\""],
  ["--remote / --onsite", "remote roles only / no remote roles"],
  ["--loc Berlin,DE", "a place (city, country code); repeat for several"],
  ["--seniority senior,staff", "level: junior, mid, senior, staff, lead…"],
  ["--posted 7d", "posted within 7d, 2w, 1m"],
  ["--min-salary 150k USD", "hide jobs that STATE pay below this (unstated pay is kept)"],
  ["--must go,kafka", "skills the job must mention"],
  ["--title \"platform engineer\"", "the title must contain this"],
  ["--exclude crypto · --exclude-company Acme", "hide jobs mentioning a word / from a company"],
];

interface SavedSearchDTO {
  id: string;
  name: string;
  query: {
    keywords: string[];
    titles: string[];
    remote: "any" | "only" | "exclude";
    locations: Array<{ city: string | null; country: string | null }>;
    seniority: string[];
    postedWithinDays: number | null;
    mustSkills: string[];
    presets: string[];
    minSalary: { amount: number; currency: string } | null;
  };
  asSource: boolean;
  cadence: string;
  lastRunAt: string | null;
  lastResult: { fetched?: number; upserted?: number; errors?: string[] } | null;
}

interface SearchResponse {
  cards: Array<FeedCard & { relevance: number; inFeed: boolean }>;
  scored: boolean;
  hidden: Record<string, number>;
  hiddenTotal: number;
  excluded: number;
  fetched: number;
  bySource: Record<string, number>;
  sources: string[];
  errors: string[];
  error?: string;
}

function describe(q: SavedSearchDTO["query"]): string {
  const parts: string[] = [];
  if (q.keywords.length) parts.push(q.keywords.map((k) => `“${k}”`).join(" or "));
  if (q.titles.length) parts.push(`title: ${q.titles.join("/")}`);
  if (q.remote === "only") parts.push("remote");
  if (q.remote === "exclude") parts.push("on-site");
  if (q.locations.length) parts.push(q.locations.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join(" | "));
  if (q.seniority.length) parts.push(q.seniority.join("/"));
  if (q.minSalary) parts.push(`≥ ${q.minSalary.amount.toLocaleString("en")} ${q.minSalary.currency}`);
  if (q.postedWithinDays) parts.push(`last ${q.postedWithinDays} days`);
  if (q.mustSkills.length) parts.push(`must: ${q.mustSkills.join(", ")}`);
  if (q.presets.length) parts.push(q.presets.map((p) => `#${p}`).join(" "));
  return parts.join(" · ") || "everything";
}

/**
 * Search — ask the live job boards now. Results are scored against YOUR profile by the same
 * scorer as Jobs (unscored before onboarding); the query's filters are a view, and what they
 * hid is always reported. Save a search to make it a tab on Jobs that refreshes every sync.
 */
/** `presets`: the built-in discovery preset ids (`listPresets()`, from the page), offered as tag chips. */
export function SearchView({ presets }: { presets: string[] }) {
  const [text, setText] = useState("");
  const [ingest, setIngest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearchDTO[] | null>(null);
  const [saveName, setSaveName] = useState("");
  const [savedMsg, setSavedMsg] = useState<{ id: string; name: string } | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const withTags = (q: string) => (tags.length && !/--presets?\b|--tag\b/.test(q) ? `${q} --preset ${tags.join(",")}` : q);

  const loadSaved = async () => {
    const r = await fetch("/api/searches", { cache: "no-store" });
    setSaved(r.ok ? ((await r.json()) as { searches: SavedSearchDTO[] }).searches : []);
  };
  useEffect(() => {
    void loadSaved();
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      setText(q);
      void run(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(q = text) {
    if (!q.trim() && !tags.length) return;
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const full = withTags(q);
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: full, ingest, limit: 40 }),
      });
      const body = (await r.json()) as SearchResponse;
      if (!r.ok) throw new Error(body.error ?? "Search failed.");
      setRes(body);
      setLastQuery(full);
      if (!saveName) setSaveName(q.replace(/--\S+(\s+[^-\s]\S*)?/g, "").replace(/"/g, "").trim().slice(0, 40));
      window.history.replaceState(null, "", `/search?q=${encodeURIComponent(q)}`);
    } catch (e) {
      setError((e as Error).message === "Failed to fetch" ? "Couldn't reach JobFlow — is it still running?" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function op(body: Record<string, unknown>, onError: (msg: string) => void = setError) {
    const r = await fetch("/api/searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) onError(out.error ?? "Request failed.");
    await loadSaved();
    return r.ok ? out : null;
  }

  async function saveCurrent() {
    setSaveErr(null);
    const existing = saved?.find((s) => s.name.toLowerCase() === saveName.trim().toLowerCase());
    if (existing && !window.confirm(`You already have a saved search called “${existing.name}”. Replace its query with this one?`)) return;
    const out = await op({ op: "save", id: existing?.id, name: saveName.trim(), text: lastQuery || withTags(text) }, setSaveErr);
    if (out?.search) setSavedMsg({ id: out.search.id, name: out.search.name });
  }

  async function runSaved(s: SavedSearchDTO) {
    setRunMsg((m) => ({ ...m, [s.id]: "running…" }));
    const out = await op({ op: "run", id: s.id });
    setRunMsg((m) => ({
      ...m,
      [s.id]: out ? `added/updated ${out.upserted ?? 0} of ${out.fetched ?? 0} fetched${out.errors?.length ? ` · ${out.errors.length} source error(s)` : ""}` : "failed",
    }));
  }

  async function removeSaved(s: SavedSearchDTO) {
    if (!window.confirm(`Delete the saved search “${s.name}”? Jobs it found stay in your list.`)) return;
    await op({ op: "delete", id: s.id });
  }

  /** a result that isn't in your jobs yet is kept (server-side) before its Job page / Tailor opens */
  async function onResultClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    const article = (e.target as HTMLElement).closest("[data-card-id]");
    if (!a || !article) return;
    const href = a.getAttribute("href") ?? "";
    const id = article.getAttribute("data-card-id")!;
    const card = res?.cards.find((c) => c.id === id);
    if (!card || card.inFeed || !(href.startsWith("/jobs/") || href.startsWith("/tailor/"))) return;
    e.preventDefault();
    const r = await fetch("/api/search/keep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return setError(out.error ?? "Couldn't open that result — search again.");
    window.location.href = href.replace(id, out.id);
  }

  const hiddenList = res ? Object.entries(res.hidden).filter(([, n]) => n > 0) : [];
  const answered = res ? Object.values(res.bySource).filter((n) => n > 0).length : 0;

  return (
    <div className="settings">
      <section className="card-block">
        <form
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What are you looking for? e.g. backend engineer --remote" aria-label="Search jobs" autoFocus />
          <button type="submit" className="save" disabled={busy || (!text.trim() && !tags.length)}>
            {busy ? "searching…" : "Search"}
          </button>
        </form>
        <div className="ux-examples">
          <span className="hint">try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="chip chip--code"
              onClick={() => {
                setText(ex);
                void run(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="ux-examples">
          <span className="hint" title="Only jobs from these discovery presets' companies and boards">only from presets:</span>
          {presets.map((p) => (
            <Chip key={p} on={tags.includes(p)} onClick={() => setTags(tags.includes(p) ? tags.filter((t) => t !== p) : [...tags, p])}>
              #{p}
            </Chip>
          ))}
          <label className="onb-inline ux-examples__end" title="Otherwise a search writes nothing; a result you open is added on its own">
            <input type="checkbox" checked={ingest} onChange={(e) => setIngest(e.target.checked)} />
            <span>add every result to my jobs</span>
          </label>
        </div>
        <details className="ux-syntax">
          <summary>All search options</summary>
          <table className="ux-syntax__table">
            <tbody>
              {SYNTAX.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td className="hint">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">The same syntax works in the terminal: <code>jobflow search backend --remote --posted 7d</code>.</p>
        </details>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <div aria-live="polite" className="sr-only">
        {busy ? "Searching the live job boards…" : res ? `${res.cards.length} result${res.cards.length === 1 ? "" : "s"}` : ""}
      </div>
      {busy && (
        <div className="search-busy">
          <p className="hint search-summary">Asking the live job boards… this usually takes a few seconds.</p>
          <Skeleton lines={3} />
        </div>
      )}

      {res && !busy && (
        <>
          {!res.scored && (
            <Banner tone="info">
              Results are <b>not scored</b> yet — <a href="/onboarding">add your résumé</a> to rank them against you. Nothing is hidden for not
              matching a profile you haven't set.
            </Banner>
          )}
          <p className="hint search-summary">
            {res.cards.length} result{res.cards.length === 1 ? "" : "s"} · {res.fetched} found across {answered} of {res.sources.length} boards
            {res.hiddenTotal > 0 && <> · {res.hiddenTotal} hidden by your search ({hiddenList.map(([k, n]) => `${k} ${n}`).join(", ")})</>}
            {res.excluded > 0 && <> · {res.excluded} left out: stated pay below your floor, or a location you can't work from</>}
            {res.scored && <> · scores are never changed by a search</>}
          </p>
          {res.errors.length > 0 && (
            <details className="hint search-summary">
              <summary>
                {res.errors.length} board{res.errors.length === 1 ? "" : "s"} didn't answer
              </summary>
              <ul className="ux-list">
                {res.errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}

          {res.cards.length === 0 ? (
            res.fetched === 0 ? (
              answered === 0 && res.errors.length ? (
                <EmptyState icon="warn" title="No board answered">
                  Check your internet connection (or a proxy blocking job sites), then try again.
                </EmptyState>
              ) : (
                <EmptyState title="Nothing found">Try fewer or broader words — e.g. “backend” instead of “senior backend engineer payments”.</EmptyState>
              )
            ) : (
              <EmptyState icon="filter" title={`${res.fetched} found, but none passed your search`}>
                <ul className="ux-list">
                  {(res.hidden.age ?? 0) > 0 && <li>Widen the date range (drop --posted, or use 1m)</li>}
                  {((res.hidden.location ?? 0) > 0 || (res.hidden.remote ?? 0) > 0) && <li>Remove or broaden --loc / --remote</li>}
                  {(res.hidden.seniority ?? 0) > 0 && <li>Drop --seniority</li>}
                  {(res.hidden.salary ?? 0) > 0 && <li>Lower --min-salary</li>}
                  {(res.hidden.skill ?? 0) > 0 && <li>Remove a --must skill</li>}
                  {(res.hidden.keyword ?? 0) > 0 && <li>Remove an --exclude word</li>}
                  {(res.hidden.preset ?? 0) > 0 && <li>Turn off a preset tag</li>}
                  {res.hiddenTotal > 0 && <li>Or remove the filters one at a time to see which one is too strict</li>}
                  {res.excluded > 0 && (
                    <li>
                      {res.excluded} were left out by your own preferences (pay floor / where you can work) — <a href="/profile#prefs">review them</a>
                    </li>
                  )}
                </ul>
              </EmptyState>
            )
          ) : (
            <div className="feed" onClickCapture={onResultClick}>
              {res.cards.map((c, i) => (
                <MatchCard key={c.id} card={c} index={i} scored={res.scored} />
              ))}
            </div>
          )}

          <section className="card-block">
            <h2>Keep this search</h2>
            <p className="hint">
              A saved search runs on every sync, adds what it finds to your jobs, and becomes a tab on the Jobs page. Query:{" "}
              <code>{lastQuery}</code>
            </p>
            <div className="field-row">
              <label>
                name
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. remote backend" />
              </label>
              <Button variant="primary" disabled={!saveName.trim()} onClick={saveCurrent}>
                Save search
              </Button>
            </div>
            {saveErr && (
              <p className="auth-error" role="alert">
                {saveErr}
              </p>
            )}
            {savedMsg && (
              <p className="notice" role="status">
                Saved “{savedMsg.name}”. <a href={`/?view=${savedMsg.id}`}>Open it in Jobs →</a>
              </p>
            )}
          </section>
        </>
      )}

      <section className="card-block">
        <h2>Saved searches</h2>
        {saved === null ? (
          <p className="hint">Loading…</p>
        ) : saved.length === 0 ? (
          <p className="empty-note">None yet. Run a search above, then “Save search” — it'll refresh on every sync and show up as a tab on Jobs.</p>
        ) : (
          <ul className="tokens-list">
            {saved.map((s) => (
              <li key={s.id}>
                <b>{s.name}</b>
                <span className="hint">
                  {describe(s.query)} · {s.lastRunAt ? `last run ${new Date(s.lastRunAt).toLocaleString()}${s.lastResult?.fetched != null ? ` (${s.lastResult.fetched} found)` : ""}` : "not run yet — runs on the next sync"}
                  {runMsg[s.id] ? ` · ${runMsg[s.id]}` : ""}
                </span>
                <span className="tokens-list__actions">
                  <ButtonLink size="sm" href={`/?view=${encodeURIComponent(s.id)}`}>
                    open in Jobs
                  </ButtonLink>
                  <Button size="sm" variant="ghost" onClick={() => void runSaved(s)} disabled={runMsg[s.id] === "running…"}>
                    run now
                  </Button>
                  <Button size="sm" variant="ghost" className="btn--danger-quiet" onClick={() => void removeSaved(s)}>
                    delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
