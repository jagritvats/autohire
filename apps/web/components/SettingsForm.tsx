"use client";

import { useState, useTransition } from "react";
import { TokensPanel } from "./TokensPanel";
import type { TenantConfig } from "@jobflow/core";

const TIER3 = ["naukri", "linkedin", "wellfound", "peerlist", "darwinbox", "ambitionbox", "glassdoor"];
/** job sites the local agent can browse on demand (the rest are enrichment / boards) */
const BROWSABLE = new Set(["naukri", "linkedin", "wellfound", "peerlist"]);
const LLM_PROVIDERS: { value: string; label: string; model: string; key: string }[] = [
  { value: "echo", label: "None — offline (echo)", model: "—", key: "" },
  { value: "anthropic", label: "Claude (Anthropic)", model: "claude-opus-4-8", key: "ANTHROPIC_API_KEY" },
  { value: "openai", label: "OpenAI", model: "gpt-4o", key: "OPENAI_API_KEY" },
  { value: "grok", label: "Grok (xAI)", model: "grok-4", key: "XAI_API_KEY" },
];


/**
 * Settings — how JobFlow works for you (your details live under Profile): the writing model,
 * how applying works on this machine, cached data, and tokens for the CLI/extension/agent.
 */
export function SettingsForm({ initialConfig, tenantId, effectiveModel }: { initialConfig: TenantConfig | null; tenantId: string; effectiveModel: string }) {
  const [config, setConfig] = useState<TenantConfig>(() => {
    const base = initialConfig ?? {
      tenantId,
      sourcesEnabled: [],
      automationFlags: { browser: "off", mode: "capture", autosubmit: false, rate: "human", tier3Sources: [] },
      llmChoice: "echo",
      llmModel: "",
      llmApiKey: "",
      llmBaseUrl: "",
      digestCadence: "daily",
      discoveryPresets: [],
      discoveryPreset: "global-remote",
      presetFeedsDisabled: [],
    };
    // tolerate older/snake-cased rows so the page never crashes on undefined arrays
    const af = (base.automationFlags ?? {}) as Partial<TenantConfig["automationFlags"]> & { tier3_sources?: string[] };
    return {
      ...base,
      automationFlags: { browser: af.browser ?? "off", mode: af.mode ?? "capture", autosubmit: false, rate: af.rate ?? "human", tier3Sources: af.tier3Sources ?? af.tier3_sources ?? [] },
    };
  });
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ where: string; text: string; bad?: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const toggleArr = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const provider = LLM_PROVIDERS.find((p) => p.value === config.llmChoice) ?? LLM_PROVIDERS[0]!;
  const keySaved = !!(config as { llmApiKeySet?: boolean }).llmApiKeySet;
  const offline = config.llmChoice === "echo";

  const saveConfig = (where: string, okText: string) =>
    start(async () => {
      setMsg(null);
      const res = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? { where, text: okText } : { where, text: body.error ?? "Couldn't save.", bad: true });
    });

  const testLlm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: config.llmChoice, model: config.llmModel, apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl }),
      });
      const body = await res.json().catch(() => ({}));
      setTestResult(
        body.ok
          ? { ok: true, text: `Connected to ${body.name} in ${body.ms} ms. Remember to save.` }
          : { ok: false, text: `${body.error ?? "Couldn't connect."} Check the key and model name.` },
      );
    } finally {
      setTesting(false);
    }
  };

  const queue = async (type: string, payload: Record<string, unknown>, okText: string) => {
    const r = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, payload }) });
    setMsg({ where: "applying", text: r.ok ? okText : "Couldn't queue that.", bad: !r.ok });
  };

  const clearDrafts = async () => {
    if (!window.confirm("Delete every cached draft (résumés, letters, answers)? You can regenerate them.")) return;
    const r = await fetch("/api/generate", { method: "DELETE" });
    setMsg({ where: "data", text: r.ok ? "Cleared all cached drafts." : "Couldn't clear drafts.", bad: !r.ok });
  };

  const Msg = ({ where }: { where: string }) =>
    msg?.where === where ? (
      <p className={msg.bad ? "auth-error" : "notice"} role={msg.bad ? "alert" : "status"}>
        {msg.text}
      </p>
    ) : null;

  return (
    <div className="settings">
      <section className="card-block" id="model">
        <h2>Writing model</h2>
        <p className="hint">
          Optional. Without one, JobFlow runs fully offline: ranking, search, résumé templates built from your own résumé, and form-filling all
          work. A model adds richer fit write-ups and writes cover letters and answers — always from your own material.
        </p>
        <p className="hint">
          In use now: <b>{effectiveModel === "echo" ? "none (offline)" : effectiveModel}</b>
        </p>
        <div className="field-row">
          <label>
            provider
            <select value={config.llmChoice} onChange={(e) => setConfig({ ...config, llmChoice: e.target.value })}>
              {LLM_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {!offline && (
            <>
              <label>
                API key
                <input
                  type="password"
                  value={config.llmApiKey}
                  autoComplete="off"
                  placeholder={keySaved ? "•••••••• saved — type to replace" : provider.key ? `paste your key (or set ${provider.key})` : ""}
                  onChange={(e) => setConfig({ ...config, llmApiKey: e.target.value })}
                />
              </label>
              <label>
                model <span className="hint">(optional)</span>
                <input value={config.llmModel} placeholder={provider.model} onChange={(e) => setConfig({ ...config, llmModel: e.target.value })} />
              </label>
              <label>
                base URL <span className="hint">(optional)</span>
                <input value={config.llmBaseUrl} placeholder="default" onChange={(e) => setConfig({ ...config, llmBaseUrl: e.target.value })} />
              </label>
            </>
          )}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {offline
            ? "Offline (echo): cover letters and written answers are switched off rather than faked; résumé drafts are labelled “from your résumé (template)”."
            : `The key is stored in your local database${keySaved ? " (one is saved)" : ""} and only sent to ${provider.label}. Your résumé, evidence and the job description go to them when you ask for a draft — nothing else.`}
        </p>
        <div className="field-row" style={{ marginTop: 10, alignItems: "center" }}>
          <button className="save" onClick={() => saveConfig("model", offline ? "Saved — running offline." : "Saved. Drafts now use your model.")} disabled={pending}>
            {pending ? "saving…" : "Save"}
          </button>
          {!offline && (
            <button className="cmd" onClick={testLlm} disabled={testing}>
              {testing ? "testing…" : "Test connection"}
            </button>
          )}
          <span aria-live="polite">{testResult && <span className={`test-result ${testResult.ok ? "ok" : "bad"}`}>{testResult.text}</span>}</span>
        </div>
        <Msg where="model" />
      </section>

      <section className="card-block" id="applying">
        <h2>Applying & the local agent</h2>
        <p className="hint">
          JobFlow never submits an application. The form-filler opens the form in a browser on your computer, types only what's in your profile,
          attaches your résumé and stops — you check every field and press submit yourself.
        </p>
        <ul className="ux-list">
          <li>
            From the terminal: <code>jobflow config set automation.fill on</code> once, then <code>jobflow apply &lt;job&gt; --fill</code>.
          </li>
          <li>
            From this page: run the local agent (<code>pnpm --filter @jobflow/agent start</code>) and switch on the option below; each job's Apply
            panel then gets a “Pre-fill” button.
          </li>
        </ul>
        <div className="field-row" style={{ alignItems: "center" }}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.automationFlags.browser === "on"}
              onChange={(e) => setConfig({ ...config, automationFlags: { ...config.automationFlags, browser: e.target.checked ? "on" : "off" } })}
            />
            let the local agent open a browser for me
          </label>
          <span className="locked" title="There is no setting that submits for you">submitting: always you</span>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary className="hint">Logged-in job sites (advanced, off by default)</summary>
          <p className="hint" style={{ marginTop: 8 }}>
            Sites you log into (LinkedIn, Naukri, Glassdoor…) are only ever read by the local agent, in your own browser session, at human pace —
            never by a server. Their terms of use are yours to accept. Also needs <code>JOBFLOW_BROWSER=on</code> in the agent's environment; see
            docs/guides/apply.md.
          </p>
          <div className="chip-row">
            {TIER3.map((s) => (
              <button
                key={s}
                className="chip amber"
                data-on={config.automationFlags.tier3Sources.includes(s)}
                aria-pressed={config.automationFlags.tier3Sources.includes(s)}
                onClick={() => setConfig({ ...config, automationFlags: { ...config.automationFlags, tier3Sources: toggleArr(config.automationFlags.tier3Sources, s) } })}
              >
                {s}
              </button>
            ))}
          </div>
          {config.automationFlags.tier3Sources.some((s) => BROWSABLE.has(s) || s === "darwinbox") && (
            <div className="chip-row" style={{ marginTop: 8 }}>
              <span className="hint">Run now on the agent:</span>
              {config.automationFlags.tier3Sources
                .filter((s) => BROWSABLE.has(s))
                .map((s) => (
                  <button key={s} className="cmd" onClick={() => queue("tier3_poll", { source: s }, `Queued a ${s} search on your local agent (runs if it's online and enabled), then your jobs re-rank.`)}>
                    search {s} →
                  </button>
                ))}
              {config.automationFlags.tier3Sources.includes("darwinbox") && (
                <button className="cmd" onClick={() => queue("local_board_poll", {}, "Queued the Darwinbox boards on your local agent.")}>
                  poll Darwinbox boards →
                </button>
              )}
            </div>
          )}
        </details>
        <button className="save ghost" onClick={() => saveConfig("applying", "Saved.")} disabled={pending} style={{ marginTop: 12 }}>
          {pending ? "saving…" : "Save"}
        </button>
        <Msg where="applying" />
      </section>

      <section className="card-block" id="data">
        <h2>Data</h2>
        <p className="hint">
          Everything lives on this machine (by default in <code>~/.jobflow</code>). Delete that folder to delete everything. To fetch new jobs, use{" "}
          <a href="/sources#sync">Sources → Sync</a>.
        </p>
        <div className="field-row">
          <button className="cmd" onClick={clearDrafts}>
            clear cached drafts
          </button>
        </div>
        <Msg where="data" />
      </section>

      <section className="card-block" id="tokens">
        <h2>API tokens</h2>
        <p className="hint">Only needed for the browser extension, the local agent, or the CLI talking to a JobFlow server.</p>
        <TokensPanel />
      </section>
    </div>
  );
}
