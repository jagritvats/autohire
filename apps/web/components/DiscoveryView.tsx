"use client";

import { useEffect, useState } from "react";

interface PresetView {
  id: string;
  label: string;
  description: string;
  markets: string[];
  active: boolean;
  feeds: Array<{ id: string; source: string; enabled: boolean }>;
  companies: number;
}
interface SourceDTO {
  id: string;
  label: string;
  config: { kind: string } & Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastCount: number | null;
  lastError: string | null;
}

type AddKind = "rss" | "json_feed" | "telegram" | "hn_thread" | "company";

/**
 * Where JobFlow looks for jobs: a built-in preset (switchable, feeds toggleable) PLUS your
 * own sources. Everything here is public data fetched politely from the server (Tier 1–2);
 * logged-in sites stay on your machine via the local agent.
 */
export function DiscoveryView() {
  const [data, setData] = useState<{ presets: PresetView[]; sources: SourceDTO[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AddKind>("rss");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch("/api/discovery");
    if (r.ok) setData(await r.json());
  };
  useEffect(() => {
    void load();
  }, []);

  async function op(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error ?? "Request failed.");
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const v = value.trim();
    if (!v && kind !== "hn_thread") return;
    const body =
      kind === "company"
        ? /^https?:\/\//.test(v)
          ? { op: "company", careersUrl: v }
          : { op: "company", name: v }
        : {
            op: "add",
            label: label || undefined,
            config:
              kind === "rss" || kind === "json_feed"
                ? { kind, url: v }
                : kind === "telegram"
                  ? { kind, channel: v.replace(/^@|^https?:\/\/t\.me\//, "") }
                  : { kind, storyId: v || null },
          };
    if (await op(body)) {
      setValue("");
      setLabel("");
    }
  }

  if (!data) return <p className="hint" role="status">loading…</p>;
  const active = data.presets.filter((p) => p.active);

  return (
    <div className="settings">
      <section className="card-block">
        <h2>
          Built-in presets <span className="hint">— curated starting sets of companies and boards; switch on as many as you like</span>
        </h2>
        <div className="onb-presets">
          {data.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="onb-preset"
              data-on={p.active} aria-pressed={p.active}
              disabled={busy || (p.active && active.length === 1)}
              title={p.active && active.length === 1 ? "keep at least one preset on" : p.active ? "click to switch off" : "click to switch on"}
              onClick={() => void op({ op: "preset", id: p.id, enabled: !p.active })}
            >
              <b>{p.label}</b>
              <span className="hint">{p.description}</span>
              <span className="hint">
                {p.companies} companies · {p.feeds.length} feeds{p.markets.length ? ` · ${p.markets.join(", ")}` : ""}
              </span>
            </button>
          ))}
        </div>
        {active.map((a) => (
          <div key={a.id}>
            <p className="hint" style={{ marginTop: 12 }}>Feeds in “{a.label}” (click to turn off/on):</p>
            <div className="chip-row">
              {a.feeds.map((f) => (
                <button key={f.id} type="button" className="chip" data-on={f.enabled} aria-pressed={f.enabled} onClick={() => void op({ op: "preset_feed", feedId: f.id, enabled: !f.enabled })}>
                  {f.source} · {f.id}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="card-block">
        <h2>
          Your sources <span className="hint">— added on top of the preset; polled on every sync</span>
        </h2>
        <div className="field-row">
          <label>
            type
            <select value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
              <option value="rss">RSS / Atom feed</option>
              <option value="json_feed">JSON feed</option>
              <option value="telegram">Telegram channel</option>
              <option value="hn_thread">HN “Who is hiring” thread</option>
              <option value="company">company (careers URL or name)</option>
            </select>
          </label>
          <label style={{ flex: "1 1 260px" }}>
            {kind === "telegram" ? "channel" : kind === "hn_thread" ? "story id (blank = latest)" : kind === "company" ? "careers URL or name" : "feed URL"}
            <input value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          {kind !== "company" && (
            <label>
              label
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
            </label>
          )}
          <button type="button" className="save" disabled={busy} onClick={() => void add()}>
            add
          </button>
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <ul className="tokens-list" style={{ marginTop: 14 }}>
          {data.sources.map((s) => (
            <li key={s.id} data-revoked={!s.enabled}>
              <b>{s.label}</b>
              <span className="hint">{s.config.kind}</span>
              <span className="hint">
                {s.lastRunAt ? `${s.lastStatus ?? ""} · ${s.lastCount ?? 0} found` : "not run yet"}
                {s.lastError ? ` · ${s.lastError}` : ""}
              </span>
              <button type="button" className="chip" onClick={() => void op({ op: "toggle", id: s.id, enabled: !s.enabled })}>
                {s.enabled ? "disable" : "enable"}
              </button>
              <button type="button" className="chip" onClick={() => void op({ op: "remove", id: s.id })}>
                remove
              </button>
            </li>
          ))}
          {data.sources.length === 0 && <li className="hint">None yet — the preset is doing all the work.</li>}
        </ul>
      </section>
    </div>
  );
}
