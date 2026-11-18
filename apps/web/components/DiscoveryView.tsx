"use client";

import "../app/ux.css";
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

const KIND_LABEL: Record<string, string> = {
  rss: "RSS feed",
  json_feed: "JSON feed",
  telegram: "Telegram channel",
  hn_thread: "HN Who is hiring",
  company_list: "company list",
};

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
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);
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
      setNotice(`Added ${kind === "company" ? "the company" : `“${label || v || "the latest HN thread"}”`}. It's fetched on the next sync — or sync now under “Sync” below.`);
      setValue("");
      setLabel("");
    }
  }

  if (!data) return <p className="hint">Loading your sources…</p>;
  const active = data.presets.filter((p) => p.active);

  return (
    <div className="settings">
      <section className="card-block">
        <h3>Presets</h3>
        <p className="hint">
          Curated starting sets of companies and job boards. Switch on every region you'd work in — each one is also a tag you can filter Jobs and
          Search by.
        </p>
        <div className="onb-presets">
          {data.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="onb-preset"
              data-on={p.active}
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
            <p className="hint" style={{ marginTop: 12 }}>Boards in “{a.label}” — click one to pause or resume it:</p>
            <div className="chip-row">
              {a.feeds.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="chip"
                  data-on={f.enabled}
                  title={f.enabled ? "polled on every sync — click to pause" : "paused — click to resume"}
                  onClick={() => void op({ op: "preset_feed", feedId: f.id, enabled: !f.enabled })}
                >
                  {f.source.replace(/_/g, " ")}
                  {f.enabled ? "" : " (paused)"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="card-block">
        <h3>Your own sources</h3>
        <p className="hint">
          Add a company you want to watch, a job feed, a Telegram channel or an HN “Who is hiring” thread. They're fetched on every sync, on
          top of your presets. Public links only — logged-in sites are only ever read by your local agent.
        </p>
        <div className="field-row">
          <label>
            type
            <select value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
              <option value="rss">RSS / Atom feed</option>
              <option value="json_feed">JSON feed</option>
              <option value="telegram">Telegram channel</option>
              <option value="hn_thread">HN “Who is hiring” thread</option>
              <option value="company">a company (careers page or name)</option>
            </select>
          </label>
          <label style={{ flex: "1 1 260px" }}>
            {kind === "telegram" ? "channel" : kind === "hn_thread" ? "story id (blank = the latest thread)" : kind === "company" ? "careers page URL or company name" : "feed URL"}
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder={
                kind === "telegram"
                  ? "e.g. remote_jobs_channel or https://t.me/…"
                  : kind === "hn_thread"
                    ? "e.g. 42575537"
                    : kind === "company"
                      ? "e.g. https://boards.greenhouse.io/acme or Acme"
                      : "https://example.com/jobs.rss"
              }
            />
          </label>
          {kind !== "company" && (
            <label>
              label
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
            </label>
          )}
          <button type="button" className="save" disabled={busy || (!value.trim() && kind !== "hn_thread")} onClick={() => void add()}>
            {busy ? "checking…" : "Add"}
          </button>
        </div>
        {error && (
          <p className="auth-error" role="alert">
            Couldn't add that: {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <ul className="tokens-list" style={{ marginTop: 14 }}>
          {data.sources.map((s) => (
            <li key={s.id} data-revoked={!s.enabled}>
              <b>{s.label}</b>
              <span className="hint">{KIND_LABEL[s.config.kind] ?? s.config.kind}</span>
              <span className="hint" data-error={!!s.lastError || undefined}>
                {!s.enabled
                  ? "paused"
                  : s.lastRunAt
                    ? `last run ${new Date(s.lastRunAt).toLocaleString()} · ${s.lastError ? `failed: ${s.lastError}` : `${s.lastCount ?? 0} job${s.lastCount === 1 ? "" : "s"} found`}`
                    : "not run yet — runs on the next sync"}
              </span>
              <button type="button" className="chip" onClick={() => void op({ op: "toggle", id: s.id, enabled: !s.enabled })}>
                {s.enabled ? "pause" : "resume"}
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => window.confirm(`Remove “${s.label}”? Jobs it already found stay in your list.`) && void op({ op: "remove", id: s.id })}
              >
                remove
              </button>
            </li>
          ))}
          {data.sources.length === 0 && <li className="hint">None yet — your presets are doing all the work. That's fine to start with.</li>}
        </ul>
      </section>
    </div>
  );
}
