"use client";

import { useEffect, useState } from "react";
import type { FeedCard } from "@/lib/feed";
import { MatchCard } from "./MatchCard";

const PRESET_TAGS = ["india", "global-remote", "us", "eu-uk"];

interface SavedSearchDTO {
  id: string;
  name: string;
  query: Record<string, unknown>;
  asSource: boolean;
  asView: boolean;
  cadence: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: Record<string, unknown> | null;
}

interface SearchResponse {
  cards: Array<FeedCard & { relevance: number; inFeed: boolean }>;
  hidden: Record<string, number>;
  hiddenTotal: number;
  excluded: number;
  fetched: number;
  bySource: Record<string, number>;
  errors: string[];
  error?: string;
}

/**
 * Live search + saved searches. Results are scored against YOUR profile by the feed's own
 * scorer; the query's filters are a view — what they hid is always counted, never silent.
 */
export function SearchView() {
  const [text, setText] = useState("");
  const [ingest, setIngest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearchDTO[]>([]);
  const [saveName, setSaveName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // presets act as TAGS: restrict a search to those presets' feeds + companies
  const withTags = (q: string) => (tags.length && !/--presets?\b|--tag\b/.test(q) ? `${q} --preset ${tags.join(",")}` : q);

  const loadSaved = async () => {
    const r = await fetch("/api/searches");
    if (r.ok) setSaved(((await r.json()) as { searches: SavedSearchDTO[] }).searches);
  };
  useEffect(() => {
    void loadSaved();
  }, []);

  async function run(q = text) {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: withTags(q), ingest, limit: 40 }),
      });
      const body = (await r.json()) as SearchResponse;
      if (!r.ok) throw new Error(body.error ?? "Search failed.");
      setRes(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function op(body: Record<string, unknown>) {
    const r = await fetch("/api/searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) setError(out.error ?? "Request failed.");
    await loadSaved();
    return out;
  }

  const hiddenList = res ? Object.entries(res.hidden).filter(([, n]) => n > 0) : [];

  return (
    <div className="settings">
      <section className="card-block">
        <h2>
          Search <span className="hint">— e.g. <code>&quot;staff backend&quot; --remote --loc Berlin,DE --seniority senior --posted 7d</code></span>
        </h2>
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input aria-label="Search query" value={text} onChange={(e) => setText(e.target.value)} placeholder="backend engineer --remote" />
          <button type="submit" className="save" disabled={busy || !text.trim()}>
            {busy ? "searching…" : "search"}
          </button>
        </form>
        <div className="chip-row" style={{ marginTop: 10 }}>
          <span className="hint">presets:</span>
          {PRESET_TAGS.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              data-on={tags.includes(p)} aria-pressed={tags.includes(p)}
              onClick={() => setTags(tags.includes(p) ? tags.filter((t) => t !== p) : [...tags, p])}
            >
              #{p}
            </button>
          ))}
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <label className="onb-inline">
            <input type="checkbox" checked={ingest} onChange={(e) => setIngest(e.target.checked)} />
            <span>add results to my feed</span>
          </label>
          <label>
            save as
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="name" />
          </label>
          <button
            type="button"
            className="save ghost"
            disabled={!saveName.trim() || !text.trim()}
            onClick={async () => {
              await op({ op: "save", name: saveName, text: withTags(text) });
              setSaveName("");
            }}
          >
            save search
          </button>
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </section>

      {saved.length > 0 && (
        <section className="card-block">
          <h2>
            Saved searches <span className="hint">— run on a schedule as sources, and usable as feed views</span>
          </h2>
          <ul className="tokens-list">
            {saved.map((s) => (
              <li key={s.id}>
                <b>{s.name}</b>
                <span className="hint">
                  {s.cadence} · {s.lastRunAt ? `last run ${new Date(s.lastRunAt).toLocaleString()}` : "never run"}
                </span>
                <a className="chip" href={`/?search=${encodeURIComponent(s.id)}`}>
                  view in feed
                </a>
                <button type="button" className="chip" onClick={() => void op({ op: "run", id: s.id })}>
                  run now
                </button>
                <button type="button" className="chip" onClick={() => void op({ op: "delete", id: s.id })}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {res && (
        <>
          <p className="hint search-summary" aria-live="polite">
            {res.fetched} fetched from {Object.keys(res.bySource).length} sources · {res.cards.length} shown
            {res.hiddenTotal > 0 && <> · {res.hiddenTotal} hidden by your filters ({hiddenList.map(([k, n]) => `${n} ${k}`).join(", ")})</>}
            {res.excluded > 0 && <> · {res.excluded} excluded (salary floor / impossible location)</>}
            {res.errors.length > 0 && <> · {res.errors.length} source errors</>}
          </p>
          <div className="feed">
            {res.cards.map((c, i) => (
              <MatchCard key={c.id} card={c} index={i} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
