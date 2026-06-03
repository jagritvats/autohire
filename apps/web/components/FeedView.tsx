"use client";

import { useMemo, useState, useTransition } from "react";
import type { FeedCard, FeedData } from "@/lib/feed";
import { MatchCard } from "./MatchCard";

const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "sre", "frontend"];
const MODES = ["remote", "hybrid", "onsite"];
const GEOS = ["worldwide", "india_ok", "apac_ok", "us_only", "eu_only"];

export function FeedView({ initial }: { initial: FeedData }) {
  const [data, setData] = useState(initial);
  const [arch, setArch] = useState<Set<string>>(new Set());
  const [modes, setModes] = useState<Set<string>>(new Set());
  const [geos, setGeos] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [hideUsOnly, setHideUsOnly] = useState(false);
  const [pending, startTransition] = useTransition();

  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    fn(next);
  };

  const cards = useMemo(() => {
    return data.cards.filter((c) => {
      if (c.score < minScore) return false;
      if (arch.size && !arch.has(c.archetype)) return false;
      if (modes.size && !modes.has(c.location.mode)) return false;
      if (geos.size && c.location.mode === "remote" && !geos.has(c.location.remoteGeo)) return false;
      if (hideUsOnly && c.location.remoteGeo === "us_only") return false;
      return true;
    });
  }, [data, arch, modes, geos, minScore, hideUsOnly]);

  const refresh = () => {
    startTransition(async () => {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (res.ok) setData(await res.json());
    });
  };

  return (
    <div className="shell">
      <aside className="rail">
        <h1 className="wordmark">
          Job<span className="flow">Flow</span>
        </h1>
        <div className="tagline">ranked match feed</div>

        <div className="rail-group">
          <h4>
            min score <span className="slider-val">{minScore}</span>
          </h4>
          <input type="range" min={0} max={90} step={5} value={minScore} onChange={(e) => setMinScore(+e.target.value)} />
        </div>

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
          <h4>honesty</h4>
          <div className="chip-row">
            <button className="chip" data-on={hideUsOnly} onClick={() => setHideUsOnly((v) => !v)}>
              hide us-only “remote”
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="statsbar">
          <Stat n={data.stats.companies} l="companies" />
          <Stat n={data.stats.postings} l="active postings" />
          <Stat n={data.stats.ranked} l="ranked" good />
          <Stat n={data.stats.excluded} l="hard-excluded" muted />
          <Stat n={cards.length} l="shown" />
          <button className="refresh" onClick={refresh} disabled={pending}>
            {pending ? "polling…" : "↻ re-poll"}
          </button>
        </div>

        <div className="feed">
          {cards.length === 0 ? (
            <div className="feed-empty">No matches under these filters.</div>
          ) : (
            cards.map((c, i) => <MatchCard key={c.id} card={c} index={i} />)
          )}
        </div>
      </main>
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
