"use client";

import { useState, useTransition } from "react";
import type { Profile, TenantConfig } from "@jobflow/core";
import { EvidenceEditor, type PromoteItem } from "./EvidenceEditor";

const SKILL_OPTIONS = [
  "java", "kotlin", "go", "scala", "rust", "csharp", "python", "typescript", "javascript",
  "react", "kafka", "rabbitmq", "postgres", "mysql", "mongodb", "redis", "elasticsearch",
  "grpc", "graphql", "rest", "microservices", "distributed_systems", "docker", "kubernetes",
  "aws", "gcp", "azure", "terraform", "ci_cd", "spark", "airflow", "ml", "fintech_domain",
];
const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "sre", "frontend", "mobile"];
const GEOS = ["worldwide", "india_ok", "apac_ok", "us_only", "eu_only"];
const LEVELS = ["junior", "mid", "senior", "staff", "lead"];
const TIER3 = ["naukri", "ambitionbox", "glassdoor", "linkedin"];
const LLM_PROVIDERS: { value: string; label: string; model: string; key: string }[] = [
  { value: "echo", label: "echo (offline stub)", model: "—", key: "" },
  { value: "anthropic", label: "Claude (Anthropic)", model: "claude-opus-4-8", key: "ANTHROPIC_API_KEY" },
  { value: "grok", label: "Grok (xAI)", model: "grok-4", key: "XAI_API_KEY" },
  { value: "openai", label: "OpenAI", model: "gpt-4o", key: "OPENAI_API_KEY" },
];

export interface GenericDraft {
  kind: string;
  text: string;
  model: string;
}

/** Client mirror of lib/sources.ts SourceDTO (kept local — that module is server-only). */
export interface ConnectedSource {
  source: string;
  label: string;
  handle: string;
  enabled: boolean;
  itemCount: number;
  preview: string;
  items: Record<string, unknown>[];
  syncedAt: string;
}

export function SettingsForm({
  initialProfile,
  initialConfig,
  initialDrafts = [],
  initialSources = [],
}: {
  initialProfile: Profile;
  initialConfig: TenantConfig | null;
  initialDrafts?: GenericDraft[];
  initialSources?: ConnectedSource[];
}) {
  const [prefs, setPrefs] = useState(initialProfile.prefs);
  const contact = prefs.contact ?? { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" };
  const setContact = (patch: Partial<typeof contact>) => setPrefs({ ...prefs, contact: { ...contact, ...patch } });
  const [yoe, setYoe] = useState(initialProfile.yoe);
  const [level, setLevel] = useState<string>(initialProfile.levelBand);
  const [masterResume, setMasterResume] = useState(initialProfile.masterResume ?? "");
  const [resumeLatex, setResumeLatex] = useState(initialProfile.resumeLatex ?? "");
  const [aboutText, setAboutText] = useState(initialProfile.aboutText ?? "");
  const [resumeFile, setResumeFile] = useState<string>(fileNameOf(contact.resumePath));
  const [uploading, setUploading] = useState(false);
  // generic (no-company) drafts, keyed by kind
  const [drafts, setDrafts] = useState<Record<string, GenericDraft | undefined>>(() => {
    const m: Record<string, GenericDraft | undefined> = {};
    for (const d of initialDrafts) m[d.kind] = d;
    return m;
  });
  const [genBusy, setGenBusy] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  // connected contexts (read-only imports), keyed by source
  const [sources, setSources] = useState<Record<string, ConnectedSource | undefined>>(() => {
    const m: Record<string, ConnectedSource | undefined> = {};
    for (const s of initialSources) m[s.source] = s;
    return m;
  });
  const [ghHandle, setGhHandle] = useState("");
  const [ycText, setYcText] = useState("");
  const [ycUrl, setYcUrl] = useState("");
  const [srcBusy, setSrcBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [config, setConfig] = useState<TenantConfig>(() => {
    const base = initialConfig ?? {
      tenantId: initialProfile.tenantId,
      sourcesEnabled: [],
      automationFlags: { browser: "off", mode: "capture", autosubmit: false, rate: "human", tier3Sources: [] },
      llmChoice: "echo",
      llmModel: "",
      llmApiKey: "",
      llmBaseUrl: "",
      digestCadence: "daily",
    };
    // defensive: tolerate older/snake-cased rows so the UI never crashes on undefined arrays
    const af = (base.automationFlags ?? {}) as Partial<TenantConfig["automationFlags"]> & { tier3_sources?: string[] };
    return {
      ...base,
      automationFlags: {
        browser: af.browser ?? "off",
        mode: af.mode ?? "capture",
        autosubmit: false,
        rate: af.rate ?? "human",
        tier3Sources: af.tier3Sources ?? af.tier3_sources ?? [],
      },
    };
  });
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  const toggleArr = <T extends string>(arr: T[], v: T): T[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const activeProvider = LLM_PROVIDERS.find((p) => p.value === config.llmChoice) ?? LLM_PROVIDERS[0]!;

  const renderSourceState = (key: string) => {
    const s = sources[key];
    if (!s) return null;
    return (
      <div className="src-state">
        <label className="toggle">
          <input type="checkbox" checked={s.enabled} onChange={(e) => toggleSource(key, e.target.checked)} />
          feed to generation
        </label>
        <span className="src-meta">
          {s.label} · {s.itemCount} item{s.itemCount === 1 ? "" : "s"} · synced {new Date(s.syncedAt).toLocaleDateString()}
        </span>
        {s.preview && (
          <details className="src-preview">
            <summary>peek</summary>
            <pre>{s.preview}</pre>
          </details>
        )}
      </div>
    );
  };

  const saveProfile = () =>
    start(async () => {
      setSaved(null);
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yoe, levelBand: level, masterResume, resumeLatex, aboutText, prefs }),
      });
      setSaved(res.ok ? "Saved + re-ranked the feed." : "Save failed.");
    });

  const uploadResume = async (file: File) => {
    setUploading(true);
    setSaved(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaved(body.error ?? "Upload failed.");
        return;
      }
      setMasterResume(body.text ?? "");
      setResumeFile(body.fileName ?? "");
      if (body.isLatex && body.latex) setResumeLatex(body.latex);
      if (body.resumePath) setContact({ resumePath: body.resumePath });
      setSaved(
        body.isLatex
          ? `Imported LaTeX résumé (${body.chars ?? 0} chars of text + the .tex template). Review, then Save.`
          : `Extracted ${body.chars ?? 0} chars from ${body.fileName}. Review the text, then Save.`,
      );
    } finally {
      setUploading(false);
    }
  };

  const genDraft = async (kind: string, force: boolean) => {
    setGenBusy(kind);
    setSaved(null);
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: null, kind, force }),
    });
    const body = await res.json().catch(() => ({}));
    setGenBusy(null);
    if (!res.ok) {
      setSaved(body.error ?? "Generation failed.");
      return;
    }
    setDrafts((cur) => ({ ...cur, [kind]: { kind, text: body.text ?? "", model: body.model ?? "echo" } }));
  };

  const clearDrafts = async () => {
    setSaved(null);
    await fetch("/api/generate", { method: "DELETE" });
    setDrafts({});
    setSaved("Cleared all cached drafts.");
  };

  const forceRepoll = () =>
    start(async () => {
      setSaved(null);
      setPolling(true);
      try {
        const res = await fetch("/api/refresh", { method: "POST" });
        setSaved(res.ok ? "Re-polled the live sources + re-ranked." : "Re-poll failed.");
      } finally {
        setPolling(false);
      }
    });

  // ── connected context (GitHub / LinkedIn / YC) ──
  const postSources = (body: unknown) =>
    fetch("/api/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const importGithub = async () => {
    if (!ghHandle.trim()) return;
    setSrcBusy("github");
    setSaved(null);
    const res = await postSources({ op: "github_import", handle: ghHandle.trim() });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return setSaved(body.error ?? "GitHub import failed.");
    setSources((s) => ({ ...s, github: body }));
    setSaved(`Imported ${body.itemCount} repos from ${body.label}.`);
  };

  const uploadLinkedin = async (files: FileList) => {
    setSrcBusy("linkedin");
    setSaved(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    const res = await fetch("/api/sources/linkedin", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return setSaved(body.error ?? "LinkedIn import failed.");
    setSources((s) => ({ ...s, linkedin: body }));
    setSaved(`Imported LinkedIn export — ${body.itemCount} positions.`);
  };

  const saveYc = async () => {
    if (!ycText.trim()) return;
    setSrcBusy("yc");
    setSaved(null);
    const res = await postSources({ op: "yc_paste", content: ycText.trim() });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return setSaved(body.error ?? "Save failed.");
    setSources((s) => ({ ...s, yc: body }));
    setYcText("");
    setSaved("Saved your YC profile as context.");
  };

  const agentYc = async () => {
    if (!ycUrl.trim()) return;
    setSrcBusy("yc");
    setSaved(null);
    const res = await postSources({ op: "yc_agent", url: ycUrl.trim() });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    setSaved(res.ok ? "Queued a YC import — your local agent will fetch it in your session (if online)." : body.error ?? "Failed.");
  };

  const toggleSource = async (source: string, enabled: boolean) => {
    setSources((s) => ({ ...s, [source]: s[source] ? { ...s[source]!, enabled } : s[source] }));
    await postSources({ op: "toggle", source, enabled });
  };

  const removeSource = async (source: string) => {
    await postSources({ op: "remove", source });
    setSources((s) => ({ ...s, [source]: undefined }));
    setSaved(`Removed ${source} context.`);
  };

  const dispatchTier3 = async (source: string) => {
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tier3_poll", payload: { source, query: "backend developer" } }),
    });
    setSaved(`Queued a ${source} browse — your local agent will run it in your session (if online + enabled).`);
  };

  const saveConfig = () =>
    start(async () => {
      setSaved(null);
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      setSaved(res.ok ? "Automation + source settings saved." : "Save failed.");
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
          ? `✓ ${body.name} · ${body.ms}ms · “${String(body.sample ?? "").slice(0, 60)}”`
          : `✕ ${body.error ?? "connection failed"}`,
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings">
      {/* ── base resume ── */}
      <section className="card-block">
        <h3>
          Base resume{" "}
          <span className="hint">— the spine generation grounds on; upload a PDF/.tex/.txt or paste it</span>
        </h3>
        <div className="resume-upload">
          <label className="upload-btn">
            {uploading ? "extracting…" : "↑ upload PDF / .tex / .txt"}
            <input
              type="file"
              accept=".pdf,.tex,.txt,.md,application/pdf,text/plain,text/x-tex"
              hidden
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadResume(f);
                e.target.value = "";
              }}
            />
          </label>
          {resumeFile && <span className="file-pill">📄 {resumeFile}</span>}
          {resumeLatex && <span className="src-tier amber">LaTeX template imported</span>}
          <span className="hint">stored for the autofill agent to attach; text below drives tailoring</span>
        </div>
        <textarea
          className="big-text"
          value={masterResume}
          rows={8}
          placeholder="Paste your resume text here, or upload above…"
          onChange={(e) => setMasterResume(e.target.value)}
        />
        <details className="latex-template" style={{ marginTop: 10 }}>
          <summary>
            LaTeX template <span className="hint">— advanced; tailoring rewrites this, keeping your styling</span>
          </summary>
          <textarea
            className="big-text"
            style={{ marginTop: 8, fontSize: 11.5 }}
            value={resumeLatex}
            rows={10}
            placeholder="Paste your résumé's .tex here (or upload a .tex above). Leave empty to use the built-in template."
            onChange={(e) => setResumeLatex(e.target.value)}
          />
        </details>
      </section>

      {/* ── about you ── */}
      <section className="card-block">
        <h3>About you <span className="hint">— a short narrative; extra background for honest, in-voice drafts</span></h3>
        <textarea
          className="big-text"
          value={aboutText}
          rows={4}
          placeholder="What you care about, the kind of systems you like building, what you're looking for…"
          onChange={(e) => setAboutText(e.target.value)}
        />
      </section>

      {/* ── connected context ── */}
      <section className="card-block">
        <h3>
          Connected context{" "}
          <span className="hint">— imported, read-only background for generation; never merged into your evidence/stack</span>
        </h3>

        {/* GitHub */}
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">GitHub <span className="src-tier">tier-1 · cloud-safe</span></span>
            {sources.github && (
              <button className="cmd" onClick={() => removeSource("github")}>
                remove
              </button>
            )}
          </div>
          <div className="add-row">
            <input value={ghHandle} placeholder="github username" onChange={(e) => setGhHandle(e.target.value)} />
            <button className="cmd add" disabled={srcBusy === "github"} onClick={importGithub}>
              {srcBusy === "github" ? "importing…" : sources.github ? "re-import" : "import"}
            </button>
          </div>
          {renderSourceState("github")}
        </div>

        {/* LinkedIn */}
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">LinkedIn <span className="src-tier amber">export upload · no scraping</span></span>
            {sources.linkedin && (
              <button className="cmd" onClick={() => removeSource("linkedin")}>
                remove
              </button>
            )}
          </div>
          <div className="resume-upload">
            <label className="upload-btn">
              {srcBusy === "linkedin" ? "parsing…" : "↑ upload export CSVs"}
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                disabled={srcBusy === "linkedin"}
                onChange={(e) => {
                  if (e.target.files?.length) uploadLinkedin(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="hint">LinkedIn → Settings → “Get a copy of your data” → upload Positions.csv / Skills.csv / Profile.csv</span>
          </div>
          {renderSourceState("linkedin")}
        </div>

        {/* YC / WaaS */}
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">YC / Work at a Startup <span className="src-tier amber">tier-3 · local / paste</span></span>
            {sources.yc && (
              <button className="cmd" onClick={() => removeSource("yc")}>
                remove
              </button>
            )}
          </div>
          <textarea
            className="big-text"
            value={ycText}
            rows={3}
            placeholder="Paste your WaaS / YC profile text (auth-gated, so the server never fetches it)…"
            onChange={(e) => setYcText(e.target.value)}
          />
          <div className="add-row" style={{ marginTop: 8 }}>
            <button className="cmd add" disabled={srcBusy === "yc"} onClick={saveYc}>
              {srcBusy === "yc" ? "saving…" : "save paste"}
            </button>
            <input value={ycUrl} placeholder="…or WaaS profile URL → import via local agent" onChange={(e) => setYcUrl(e.target.value)} />
            <button className="cmd" disabled={srcBusy === "yc" || !ycUrl.trim()} onClick={agentYc}>
              import via agent →
            </button>
          </div>
          {renderSourceState("yc")}
        </div>
      </section>

      {/* ── evidence bank ── */}
      <section className="card-block">
        <h3>
          Evidence Bank{" "}
          <span className="hint">— the cited spine; every tailored bullet/answer maps to an entry here (§4)</span>
        </h3>
        <EvidenceEditor
          promote={[
            ...((sources.github?.items ?? []).map((item) => ({ source: "github", item })) as PromoteItem[]),
            ...((sources.linkedin?.items ?? []).map((item) => ({ source: "linkedin", item })) as PromoteItem[]),
          ]}
        />
      </section>

      {/* ── stack ── */}
      <section className="card-block">
        <h3>Tech stack <span className="hint">— what you bring; drives stack-adjacency scoring</span></h3>
        <div className="chip-row">
          {SKILL_OPTIONS.map((s) => (
            <button
              key={s}
              className="chip"
              data-on={prefs.stackProfile.includes(s)}
              onClick={() => setPrefs({ ...prefs, stackProfile: toggleArr(prefs.stackProfile, s) })}
            >
              {s.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </section>

      {/* ── comp ── */}
      <section className="card-block">
        <h3>Expected comp <span className="hint">— floor is a soft signal; only a high-confidence number below it hard-excludes</span></h3>
        <div className="field-row">
          <label>
            floor
            <input
              type="number"
              value={prefs.salaryFloor}
              step={100000}
              onChange={(e) => setPrefs({ ...prefs, salaryFloor: +e.target.value })}
            />
          </label>
          <label>
            currency
            <select value={prefs.currency} onChange={(e) => setPrefs({ ...prefs, currency: e.target.value })}>
              {["INR", "USD", "EUR", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            YoE
            <input type="number" value={yoe} step={0.5} onChange={(e) => setYoe(+e.target.value)} />
          </label>
          <label>
            level
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* ── targets ── */}
      <section className="card-block">
        <h3>Target archetypes</h3>
        <div className="chip-row">
          {ARCHETYPES.map((a) => (
            <button
              key={a}
              className="chip"
              data-on={prefs.targetArchetypes.includes(a as never)}
              onClick={() => setPrefs({ ...prefs, targetArchetypes: toggleArr(prefs.targetArchetypes as string[], a) as never })}
            >
              {a.replace(/_/g, "/")}
            </button>
          ))}
        </div>
      </section>

      {/* ── geo ── */}
      <section className="card-block">
        <h3>Remote-geo you'll accept <span className="hint">— a us-only "remote" is down-weighted + flagged, never hidden</span></h3>
        <div className="chip-row">
          {GEOS.map((g) => (
            <button
              key={g}
              className="chip"
              data-on={(prefs.remoteGeoOk as string[]).includes(g)}
              onClick={() => setPrefs({ ...prefs, remoteGeoOk: toggleArr(prefs.remoteGeoOk as string[], g) as never })}
            >
              {g.replace(/_/g, "-")}
            </button>
          ))}
          <button className="chip" data-on={prefs.relocate} onClick={() => setPrefs({ ...prefs, relocate: !prefs.relocate })}>
            open to relocate
          </button>
        </div>
      </section>

      {/* ── location weights ── */}
      <section className="card-block">
        <h3>Location weights <span className="hint">— ranked preference, not a binary filter (§11.3)</span></h3>
        <div className="weights">
          {prefs.locationWeights.map((w, i) => (
            <div className="weight-row" key={i}>
              <span className="wlabel">{w.label}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={w.weight}
                onChange={(e) => {
                  const lw = [...prefs.locationWeights];
                  lw[i] = { ...lw[i]!, weight: +e.target.value };
                  setPrefs({ ...prefs, locationWeights: lw });
                }}
              />
              <span className="wval">{w.weight.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── contact / autofill identity ── */}
      <section className="card-block">
        <h3>Contact <span className="hint">— what the local form-filler types; only these stored values are ever entered, always stopping at review (§7.1)</span></h3>
        <div className="field-row">
          <label>first name<input value={contact.firstName} onChange={(e) => setContact({ firstName: e.target.value })} /></label>
          <label>last name<input value={contact.lastName} onChange={(e) => setContact({ lastName: e.target.value })} /></label>
          <label>email<input value={contact.email} onChange={(e) => setContact({ email: e.target.value })} /></label>
          <label>phone<input value={contact.phone} onChange={(e) => setContact({ phone: e.target.value })} /></label>
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <label>linkedin<input value={contact.linkedin} onChange={(e) => setContact({ linkedin: e.target.value })} /></label>
          <label>github<input value={contact.github} onChange={(e) => setContact({ github: e.target.value })} /></label>
          <label>portfolio<input value={contact.portfolio} onChange={(e) => setContact({ portfolio: e.target.value })} /></label>
          <label>resume path<input value={contact.resumePath} onChange={(e) => setContact({ resumePath: e.target.value })} placeholder="~/resumes/tailored.pdf" /></label>
        </div>
      </section>

      <button className="save" onClick={saveProfile} disabled={pending}>
        {pending ? "saving…" : "Save profile + re-rank"}
      </button>

      {/* ── generic drafts ── */}
      <section className="card-block">
        <h3>
          Drafts <span className="hint">— reusable, company-agnostic; per-job tailoring lives on each match card (✎ tailor)</span>
        </h3>
        {[
          { kind: "about_blurb", label: "About-me blurb" },
          { kind: "interesting_problem", label: "Interesting problem you've solved" },
        ].map(({ kind, label }) => {
          const d = drafts[kind];
          return (
            <div className="draft-row" key={kind}>
              <div className="draft-head">
                <span className="draft-label">{label}</span>
                <div className="draft-btns">
                  {d && <span className="gen-meta">{d.model}</span>}
                  <button className="cmd" disabled={genBusy === kind} onClick={() => genDraft(kind, !!d)}>
                    {genBusy === kind ? "generating…" : d ? "↻ regenerate" : "generate"}
                  </button>
                </div>
              </div>
              {d?.text ? <p className="draft-text">{d.text}</p> : <div className="gen-empty">Not generated yet.</div>}
            </div>
          );
        })}
        <p className="hint" style={{ marginTop: 8 }}>
          Save your resume + about first — drafts ground on them and the Evidence Bank. With no LLM key set, the
          offline <code>echo</code> provider returns a deterministic stub.
        </p>
      </section>

      {/* ── cache & refresh ── */}
      <section className="card-block">
        <h3>Cache &amp; refresh <span className="hint">— drafts are cached durably + locally; bust them or re-poll the feed</span></h3>
        <div className="field-row">
          <button className="cmd" onClick={clearDrafts}>
            ✕ clear tailored drafts
          </button>
          <button className="cmd" disabled={polling || pending} onClick={forceRepoll}>
            {polling ? "polling…" : "↻ force re-poll feed"}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          “Clear drafts” drops every cached resume/answer (yours stay regenerable). “Force re-poll” re-fetches the live
          Tier 1–2 sources and re-ranks — the same as the feed’s sync button.
        </p>
      </section>

      {/* ── LLM / generation provider ── */}
      <section className="card-block">
        <h3>
          Generation model <span className="hint">— which API tailors your resume + answers; key blank = read from .env</span>
        </h3>
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
          <label>
            model
            <input
              value={config.llmModel}
              placeholder={activeProvider.model}
              onChange={(e) => setConfig({ ...config, llmModel: e.target.value })}
            />
          </label>
          <label>
            api key
            <input
              type="password"
              value={config.llmApiKey}
              placeholder={activeProvider.key ? `or set ${activeProvider.key}` : "n/a"}
              disabled={config.llmChoice === "echo"}
              onChange={(e) => setConfig({ ...config, llmApiKey: e.target.value })}
            />
          </label>
          <label>
            base url
            <input
              value={config.llmBaseUrl}
              placeholder="default"
              disabled={config.llmChoice === "echo"}
              onChange={(e) => setConfig({ ...config, llmBaseUrl: e.target.value })}
            />
          </label>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {config.llmChoice === "echo"
            ? "echo is the offline deterministic stub — pick Claude / Grok / OpenAI for real drafts."
            : `Uses ${activeProvider.label}. A key here is stored in tenant_config (single-user/local); leave blank to read ${activeProvider.key} from .env.`}
        </p>
        <div className="field-row" style={{ marginTop: 10, alignItems: "center" }}>
          <button className="save ghost" onClick={saveConfig} disabled={pending}>
            {pending ? "saving…" : "Save generation settings"}
          </button>
          <button className="cmd" onClick={testLlm} disabled={testing}>
            {testing ? "testing…" : "test connection"}
          </button>
          {testResult && <span className={`test-result ${testResult.startsWith("✓") ? "ok" : "bad"}`}>{testResult}</span>}
        </div>
      </section>

      {/* ── automation / sources ── */}
      <section className="card-block danger">
        <h3>Automation <span className="hint">— local agent only (§7.1). Off by default. Autosubmit is locked false.</span></h3>
        <div className="field-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.automationFlags.browser === "on"}
              onChange={(e) =>
                setConfig({ ...config, automationFlags: { ...config.automationFlags, browser: e.target.checked ? "on" : "off" } })
              }
            />
            browser automation (master)
          </label>
          <span className="locked">autosubmit: false · locked</span>
        </div>
        <div className="chip-row">
          <span className="hint">Tier-3 sources (opt in per source):</span>
          {TIER3.map((s) => (
            <button
              key={s}
              className="chip amber"
              data-on={config.automationFlags.tier3Sources.includes(s)}
              onClick={() =>
                setConfig({
                  ...config,
                  automationFlags: { ...config.automationFlags, tier3Sources: toggleArr(config.automationFlags.tier3Sources, s) },
                })
              }
            >
              {s}
            </button>
          ))}
        </div>
        <p className="risk">
          Tier-3 + form-fill run on your local agent, in your own session, human-paced — never on the server, never auto-submitting.
          Enabling also needs <code>JOBFLOW_BROWSER=on</code> in the agent's env (machine-level gate) and the agent running
          (<code>pnpm --filter @jobflow/agent start</code>). See docs/SETUP.md.
        </p>
        {config.automationFlags.tier3Sources.length > 0 && (
          <div className="chip-row" style={{ marginTop: 8 }}>
            <span className="hint">Dispatch a browse (local agent):</span>
            {config.automationFlags.tier3Sources.map((s) => (
              <button key={s} className="cmd" onClick={() => dispatchTier3(s)}>
                browse {s} →
              </button>
            ))}
          </div>
        )}
        <button className="save ghost" onClick={saveConfig} disabled={pending} style={{ marginTop: 12 }}>
          {pending ? "saving…" : "Save automation settings"}
        </button>
      </section>

      {saved && <div className="saved-toast">{saved}</div>}
    </div>
  );
}

/** Derive a display filename from a stored absolute/relative resume path. */
function fileNameOf(p: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}
