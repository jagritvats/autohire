"use client";

import { useEffect, useState } from "react";

interface TokenMeta {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

// the `cli` scope is a plain HTTP API token (there is no `jobflow login`: the CLI talks to
// its own local store, not to a server) — label it for what it does
const SCOPES = [
  { id: "extension", label: "extension", hint: "paste into the browser extension's options page" },
  { id: "agent", label: "local agent", hint: "set JOBFLOW_AGENT_TOKEN in the agent's .env" },
  { id: "cli", label: "scripts / API", hint: "send as Authorization: Bearer <token> to this server's /api routes" },
] as const;

/** API tokens for the browser extension, the local agent and scripts — shown once, stored hashed. */
export function TokensPanel() {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["extension"]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/tokens");
    if (res.ok) setTokens(((await res.json()) as { tokens: TokenMeta[] }).tokens);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setError(null);
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name || scopes.join("+"), scopes }),
    });
    const body = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !body.token) return setError(body.error ?? "Could not create the token.");
    setFresh(body.token);
    setName("");
    await load();
  }

  async function revoke(id: string) {
    await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="tokens-panel">
      <p className="hint">
        A token lets the browser extension, your local agent or a script act as you on this server. Each is shown once and stored
        only as a hash — revoke one if a machine is lost.
      </p>
      <div className="tokens-new">
        <input aria-label="Token name" placeholder="name (e.g. laptop)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        {SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="chip"
            data-on={scopes.includes(s.id)} aria-pressed={scopes.includes(s.id)}
            title={s.hint}
            onClick={() => setScopes(scopes.includes(s.id) ? scopes.filter((x) => x !== s.id) : [...scopes, s.id])}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="chip" disabled={scopes.length === 0} onClick={create}>
          + create
        </button>
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {fresh && (
        <div className="token-fresh">
          <code>{fresh}</code>
          <button type="button" className="chip" onClick={() => void navigator.clipboard?.writeText(fresh)}>
            copy
          </button>
          <span className="hint">Copy it now — it won&apos;t be shown again.</span>
        </div>
      )}
      <ul className="tokens-list">
        {tokens.map((t) => (
          <li key={t.id} data-revoked={!!t.revokedAt}>
            <span>{t.name}</span>
            <span className="hint">{t.scopes.join(", ")}</span>
            <span className="hint">
              {t.revokedAt ? "revoked" : t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}
            </span>
            {!t.revokedAt && (
              <button type="button" className="chip" onClick={() => void revoke(t.id)}>
                revoke
              </button>
            )}
          </li>
        ))}
        {tokens.length === 0 && <li className="hint">No tokens yet.</li>}
      </ul>
    </div>
  );
}
