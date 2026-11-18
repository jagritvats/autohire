"use client";

import "../app/ux.css";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { Profile } from "@jobflow/core";
import { EvidenceEditor, type PromoteItem } from "./EvidenceEditor";
import { roleText } from "@/lib/cardText";

/** common skills offered as one-click suggestions; anything can be typed in */
const SKILL_SUGGESTIONS = [
  "java", "kotlin", "go", "scala", "rust", "csharp", "python", "typescript", "javascript", "react",
  "kafka", "postgres", "mysql", "mongodb", "redis", "elasticsearch", "grpc", "graphql", "rest",
  "microservices", "distributed_systems", "docker", "kubernetes", "aws", "gcp", "azure", "terraform",
  "ci_cd", "spark", "airflow", "ml",
];
const ARCHETYPES = ["backend", "platform", "infra_devops", "fullstack", "data_ml", "sre", "frontend", "mobile"];
const GEOS: Array<{ id: string; label: string }> = [
  { id: "worldwide", label: "anywhere (worldwide)" },
  { id: "us_only", label: "US-only roles" },
  { id: "eu_only", label: "EU-only roles" },
  { id: "us_eu", label: "US or EU" },
  { id: "india_ok", label: "India OK" },
  { id: "apac_ok", label: "APAC" },
];
const LEVELS = ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "manager", "director"];
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD", "CHF"];

const SECTIONS: Array<[string, string]> = [
  ["resume", "Résumé"],
  ["contact", "Contact"],
  ["skills", "Skills & level"],
  ["prefs", "What you want"],
  ["about", "About you"],
  ["evidence", "Evidence Bank"],
  ["context", "Connected context"],
  ["answers", "Reusable answers"],
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

/**
 * Profile — who you are to JobFlow: the résumé every draft is grounded in, your contact
 * details (all the form-filler ever types), skills, what you want (weighted signals, not
 * filters), evidence, and connected context. One Save for everything, with a visible
 * unsaved-changes bar; saving re-ranks your jobs.
 */
export function ProfileForm({
  initialProfile,
  initialDrafts = [],
  initialSources = [],
  llmReady,
}: {
  initialProfile: Profile;
  initialDrafts?: GenericDraft[];
  initialSources?: ConnectedSource[];
  llmReady: boolean;
}) {
  const [prefs, setPrefs] = useState(initialProfile.prefs);
  const contact = prefs.contact;
  const setContact = (patch: Partial<typeof contact>) => setPrefs({ ...prefs, contact: { ...contact, ...patch } });
  const [yoe, setYoe] = useState(initialProfile.yoe);
  const [level, setLevel] = useState<string>(initialProfile.levelBand);
  const [masterResume, setMasterResume] = useState(initialProfile.masterResume ?? "");
  const [resumeLatex, setResumeLatex] = useState(initialProfile.resumeLatex ?? "");
  const [aboutText, setAboutText] = useState(initialProfile.aboutText ?? "");
  const [marketsText, setMarketsText] = useState(initialProfile.prefs.markets.join(", "));
  const [skillInput, setSkillInput] = useState("");
  const [locInput, setLocInput] = useState("");
  const [resumeFile, setResumeFile] = useState<string>(fileNameOf(contact.resumePath));
  const [uploading, setUploading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, GenericDraft | undefined>>(() => Object.fromEntries(initialDrafts.map((d) => [d.kind, d])));
  const [genBusy, setGenBusy] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, ConnectedSource | undefined>>(() => Object.fromEntries(initialSources.map((s) => [s.source, s])));
  const [ghHandle, setGhHandle] = useState("");
  const [ycText, setYcText] = useState("");
  const [srcBusy, setSrcBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const current = useMemo(
    () => JSON.stringify({ prefs, yoe, level, masterResume, resumeLatex, aboutText, marketsText }),
    [prefs, yoe, level, masterResume, resumeLatex, aboutText, marketsText],
  );
  const [savedSnapshot, setSavedSnapshot] = useState(current);
  const dirty = current !== savedSnapshot;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const toggleArr = <T extends string>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const say = (text: string, bad = false) => setMsg({ text, bad });

  const saveProfile = () =>
    start(async () => {
      setMsg(null);
      const markets = marketsText
        .split(/[,\s]+/)
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      const badMarket = markets.find((m) => !/^[A-Z]{2}$/.test(m));
      if (badMarket) return say(`“${badMarket}” isn't a 2-letter country code (like US, DE, IN).`, true);
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yoe, levelBand: level, masterResume, resumeLatex, aboutText, prefs: { ...prefs, homeCountry: prefs.homeCountry.trim().toUpperCase(), markets } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return say(body.error ?? "Couldn't save — check the highlighted values.", true);
      setSavedSnapshot(current);
      say("Saved. Your jobs were re-ranked with the new profile.");
    });

  const uploadResume = async (file: File) => {
    setUploading(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return say(body.error ?? "Couldn't read that file. Try a PDF or DOCX with selectable text, or paste the text below.", true);
      setMasterResume(body.text ?? "");
      setResumeFile(body.fileName ?? "");
      if (body.isLatex && body.latex) setResumeLatex(body.latex);
      if (body.resumePath) setContact({ resumePath: body.resumePath });
      say(
        body.isLatex
          ? `Read your LaTeX résumé (${body.chars ?? 0} characters + the .tex template). Check it, then Save.`
          : `Read ${body.chars ?? 0} characters from ${body.fileName}. Check the text below, then Save.` +
              (body.latexKept ? " Your earlier LaTeX template is still set — clear it under “LaTeX template” if it's out of date." : ""),
      );
    } finally {
      setUploading(false);
    }
  };

  const addSkill = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
    if (s && !prefs.stackProfile.includes(s)) setPrefs({ ...prefs, stackProfile: [...prefs.stackProfile, s] });
  };
  const addLocation = (raw: string) => {
    const label = raw.trim().toLowerCase();
    if (!label || prefs.locationWeights.some((w) => w.label === label)) return;
    setPrefs({ ...prefs, locationWeights: [...prefs.locationWeights, { label, weight: Math.max(0.5, 1 - prefs.locationWeights.length * 0.1) }] });
  };

  const genDraft = async (kind: string, force: boolean) => {
    setGenBusy(kind);
    setMsg(null);
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postingId: null, kind, force }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return say(body.error ?? "Couldn't write that draft.", true);
      setDrafts((cur) => ({ ...cur, [kind]: { kind, text: body.text ?? "", model: body.model ?? "echo" } }));
    } catch (e) {
      say(`Couldn't write that draft — ${(e as Error).message}`, true);
    } finally {
      setGenBusy(null);
    }
  };

  // ── connected context (GitHub / LinkedIn / YC) ──
  const postSources = (body: unknown) => fetch("/api/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const importGithub = async () => {
    if (!ghHandle.trim()) return;
    setSrcBusy("github");
    const res = await postSources({ op: "github_import", handle: ghHandle.trim() });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return say(body.error ?? "GitHub import failed.", true);
    setSources((s) => ({ ...s, github: body }));
    say(`Imported ${body.itemCount} repositories from ${body.label}.`);
  };
  const uploadLinkedin = async (files: FileList) => {
    setSrcBusy("linkedin");
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    const res = await fetch("/api/sources/linkedin", { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return say(body.error ?? "LinkedIn import failed.", true);
    setSources((s) => ({ ...s, linkedin: body }));
    say(`Imported your LinkedIn export — ${body.itemCount} positions.`);
  };
  const saveYc = async () => {
    if (!ycText.trim()) return;
    setSrcBusy("yc");
    const res = await postSources({ op: "yc_paste", content: ycText.trim() });
    const body = await res.json().catch(() => ({}));
    setSrcBusy(null);
    if (!res.ok) return say(body.error ?? "Save failed.", true);
    setSources((s) => ({ ...s, yc: body }));
    setYcText("");
    say("Saved your YC / Work at a Startup profile as context.");
  };
  const toggleSource = async (source: string, enabled: boolean) => {
    setSources((s) => ({ ...s, [source]: s[source] ? { ...s[source]!, enabled } : s[source] }));
    await postSources({ op: "toggle", source, enabled });
  };
  const removeSource = async (source: string) => {
    await postSources({ op: "remove", source });
    setSources((s) => ({ ...s, [source]: undefined }));
    say(`Removed ${source}.`);
  };
  const sourceState = (key: string) => {
    const s = sources[key];
    if (!s) return null;
    return (
      <div className="src-state">
        <label className="toggle">
          <input type="checkbox" checked={s.enabled} onChange={(e) => toggleSource(key, e.target.checked)} />
          use when writing drafts
        </label>
        <span className="src-meta">
          {s.label} · {s.itemCount} item{s.itemCount === 1 ? "" : "s"} · imported {new Date(s.syncedAt).toLocaleDateString()}
        </span>
        <button className="cmd" onClick={() => removeSource(key)}>
          remove
        </button>
        {s.preview && (
          <details className="src-preview">
            <summary>peek</summary>
            <pre>{s.preview}</pre>
          </details>
        )}
      </div>
    );
  };

  const suggestions = SKILL_SUGGESTIONS.filter((s) => !prefs.stackProfile.includes(s));

  return (
    <div className="settings">
      <nav className="ux-section-nav" aria-label="Profile sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <section className="card-block" id="resume">
        <h3>Résumé</h3>
        <p className="hint">
          Every tailored résumé, letter and answer is built from this text, your Evidence Bank and your skills — rephrased, never extended.
          To re-import with a review of what was found, use <a href="/onboarding">guided import</a>.
        </p>
        <div className="resume-upload">
          <label className="upload-btn">
            {uploading ? "reading…" : "↑ upload PDF / DOCX / .tex / .md / .txt"}
            <input
              type="file"
              accept=".pdf,.docx,.tex,.txt,.md,application/pdf,text/plain,text/x-tex"
              hidden
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadResume(f);
                e.target.value = "";
              }}
            />
          </label>
          {resumeFile ? <span className="file-pill">📄 {resumeFile} (attached to applications)</span> : <span className="hint">No file yet — forms need one to attach.</span>}
          {resumeLatex && <span className="src-tier amber">LaTeX template imported</span>}
        </div>
        <textarea className="big-text" value={masterResume} rows={8} placeholder="Paste your résumé text here, or upload a file above…" onChange={(e) => setMasterResume(e.target.value)} aria-label="Résumé text" />
        <details className="latex-template" style={{ marginTop: 10 }}>
          <summary>
            LaTeX template <span className="hint">— optional; LaTeX tailoring rewrites the body and keeps your styling</span>
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

      <section className="card-block" id="contact">
        <h3>Contact</h3>
        <p className="hint">The form-filler types only these values, and always stops before submit so you can check them.</p>
        <div className="field-row">
          <label>first name<input value={contact.firstName} onChange={(e) => setContact({ firstName: e.target.value })} /></label>
          <label>last name<input value={contact.lastName} onChange={(e) => setContact({ lastName: e.target.value })} /></label>
          <label>email<input type="email" value={contact.email} onChange={(e) => setContact({ email: e.target.value })} /></label>
          <label>phone<input value={contact.phone} onChange={(e) => setContact({ phone: e.target.value })} /></label>
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <label>LinkedIn<input value={contact.linkedin} onChange={(e) => setContact({ linkedin: e.target.value })} /></label>
          <label>GitHub<input value={contact.github} onChange={(e) => setContact({ github: e.target.value })} /></label>
          <label>portfolio<input value={contact.portfolio} onChange={(e) => setContact({ portfolio: e.target.value })} /></label>
          <label title="The file attached to applications when there's no tailored PDF for that job">
            résumé file to attach<input value={contact.resumePath} onChange={(e) => setContact({ resumePath: e.target.value })} placeholder="/path/to/resume.pdf" />
          </label>
        </div>
      </section>

      <section className="card-block" id="skills">
        <h3>Skills & level</h3>
        <p className="hint">Your stack drives how close each job's stack is to yours — a near miss is a ramp note, never a hidden job. Click a skill to remove it.</p>
        <div className="chip-row">
          {prefs.stackProfile.length === 0 && <span className="hint">No skills yet — add a few below.</span>}
          {prefs.stackProfile.map((s) => (
            <button key={s} className="chip" data-on="true" onClick={() => setPrefs({ ...prefs, stackProfile: prefs.stackProfile.filter((x) => x !== s) })} title="remove">
              {s.replace(/_/g, " ")} ✕
            </button>
          ))}
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <label>
            add a skill
            <input
              value={skillInput}
              placeholder="type and press Enter"
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSkill(skillInput);
                  setSkillInput("");
                }
              }}
            />
          </label>
          <label>
            years of experience
            <input type="number" min={0} max={60} step={0.5} value={yoe} onChange={(e) => setYoe(+e.target.value)} />
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
        {suggestions.length > 0 && (
          <div className="chip-row" style={{ marginTop: 10 }}>
            <span className="hint">suggestions:</span>
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => addSkill(s)}>
                + {s.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card-block" id="prefs">
        <h3>What you want</h3>
        <p className="hint">
          These are weighted signals, not filters — nothing is hidden for being elsewhere. Only two things ever leave a job out: pay the posting
          clearly states below your floor, and a location you can't work from.
        </p>
        <div className="field-row">
          <label>
            home country
            <input value={prefs.homeCountry} maxLength={2} placeholder="e.g. US, DE, IN" onChange={(e) => setPrefs({ ...prefs, homeCountry: e.target.value.toUpperCase() })} />
          </label>
          <label>
            countries to search
            <input value={marketsText} placeholder="e.g. US, CA" onChange={(e) => setMarketsText(e.target.value)} />
          </label>
          <label>
            salary floor (yearly)
            <input type="number" min={0} value={prefs.salaryFloor} step={1000} onChange={(e) => setPrefs({ ...prefs, salaryFloor: +e.target.value })} />
          </label>
          <label>
            currency
            <select value={prefs.currency} onChange={(e) => setPrefs({ ...prefs, currency: e.target.value })}>
              {[...new Set([prefs.currency, ...CURRENCIES])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>Remote roles you can take:</p>
        <div className="chip-row">
          {GEOS.map((g) => (
            <button key={g.id} className="chip" data-on={(prefs.remoteGeoOk as string[]).includes(g.id)} onClick={() => setPrefs({ ...prefs, remoteGeoOk: toggleArr(prefs.remoteGeoOk as string[], g.id) as never })}>
              {g.label}
            </button>
          ))}
          <button className="chip" data-on={prefs.relocate} onClick={() => setPrefs({ ...prefs, relocate: !prefs.relocate })}>
            open to relocating
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>Role types you want:</p>
        <div className="chip-row">
          {ARCHETYPES.map((a) => (
            <button
              key={a}
              className="chip"
              data-on={prefs.targetArchetypes.includes(a as never)}
              onClick={() => setPrefs({ ...prefs, targetArchetypes: toggleArr(prefs.targetArchetypes as string[], a) as never })}
            >
              {roleText(a)}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 12 }}>Places, in order of preference (the slider is how much you'd like it):</p>
        <div className="weights">
          {prefs.locationWeights.map((w, i) => (
            <div className="weight-row" key={w.label}>
              <span className="wlabel">{w.label}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={w.weight}
                aria-label={`How much you'd like ${w.label}`}
                onChange={(e) => {
                  const lw = [...prefs.locationWeights];
                  lw[i] = { ...lw[i]!, weight: +e.target.value };
                  setPrefs({ ...prefs, locationWeights: lw });
                }}
              />
              <span className="wval">{w.weight.toFixed(2)}</span>
              <button className="chip" onClick={() => setPrefs({ ...prefs, locationWeights: prefs.locationWeights.filter((_, j) => j !== i) })} title="remove">
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="field-row" style={{ marginTop: 8 }}>
          <label>
            add a place
            <input
              value={locInput}
              placeholder="e.g. Berlin, remote, London"
              onChange={(e) => setLocInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLocation(locInput);
                  setLocInput("");
                }
              }}
            />
          </label>
        </div>
      </section>

      <section className="card-block" id="about">
        <h3>About you</h3>
        <p className="hint">A short note in your own words — what you like building, what you're looking for. Used as background for drafts.</p>
        <textarea className="big-text" value={aboutText} rows={4} placeholder="What you care about, the kind of systems you like building, what you're looking for…" onChange={(e) => setAboutText(e.target.value)} />
      </section>

      <div className="ux-savebar" data-dirty={dirty}>
        <button className="save" onClick={saveProfile} disabled={pending || !dirty}>
          {pending ? "saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <span className={msg?.bad ? "auth-error" : "hint"} role="status">
          {msg?.text ?? (dirty ? "You have unsaved changes. Saving re-ranks your jobs." : "Everything above is saved.")}
        </span>
      </div>

      <section className="card-block" id="evidence">
        <h3>Evidence Bank</h3>
        <p className="hint">Concrete things you did, in your words. Every tailored bullet and answer must rest on one of these, your résumé or your skills. Saved as you edit.</p>
        <EvidenceEditor
          promote={[
            ...((sources.github?.items ?? []).map((item) => ({ source: "github", item })) as PromoteItem[]),
            ...((sources.linkedin?.items ?? []).map((item) => ({ source: "linkedin", item })) as PromoteItem[]),
          ]}
        />
      </section>

      <section className="card-block" id="context">
        <h3>Connected context</h3>
        <p className="hint">Optional background for drafts — read-only, never merged into your skills or evidence unless you promote an item.</p>
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">GitHub</span>
          </div>
          <div className="add-row">
            <input value={ghHandle} placeholder="your GitHub username" onChange={(e) => setGhHandle(e.target.value)} />
            <button className="cmd add" disabled={srcBusy === "github" || !ghHandle.trim()} onClick={importGithub}>
              {srcBusy === "github" ? "importing…" : sources.github ? "re-import" : "import public repos"}
            </button>
          </div>
          {sourceState("github")}
        </div>
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">LinkedIn <span className="src-tier amber">your data export — never scraped</span></span>
          </div>
          <div className="resume-upload">
            <label className="upload-btn">
              {srcBusy === "linkedin" ? "reading…" : "↑ upload export CSVs"}
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                disabled={srcBusy === "linkedin"}
                onChange={(e) => {
                  if (e.target.files?.length) void uploadLinkedin(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="hint">LinkedIn → Settings → “Get a copy of your data” → upload Positions.csv, Skills.csv, Profile.csv</span>
          </div>
          {sourceState("linkedin")}
        </div>
        <div className="src-block">
          <div className="src-head">
            <span className="src-name">YC / Work at a Startup <span className="src-tier amber">paste — it's behind a login</span></span>
          </div>
          <textarea className="big-text" value={ycText} rows={3} placeholder="Paste your Work at a Startup profile text…" onChange={(e) => setYcText(e.target.value)} />
          <div className="add-row" style={{ marginTop: 8 }}>
            <button className="cmd add" disabled={srcBusy === "yc" || !ycText.trim()} onClick={saveYc}>
              {srcBusy === "yc" ? "saving…" : "save"}
            </button>
          </div>
          {sourceState("yc")}
        </div>
      </section>

      <section className="card-block" id="answers">
        <h3>Reusable answers</h3>
        <p className="hint">
          Company-agnostic answers you can paste anywhere. Per-job drafts live on each job's Tailor page.{" "}
          {!llmReady && (
            <>
              These need a writing model — <a href="/settings#model">connect one in Settings</a>. Without one, JobFlow won't pass off a template as
              your writing.
            </>
          )}
        </p>
        {[
          { kind: "about_blurb", label: "About me" },
          { kind: "interesting_problem", label: "An interesting problem I solved" },
        ].map(({ kind, label }) => {
          const d = drafts[kind];
          return (
            <div className="draft-row" key={kind}>
              <div className="draft-head">
                <span className="draft-label">{label}</span>
                <div className="draft-btns">
                  {d && <span className="gen-meta">written by {d.model}</span>}
                  <button className="cmd" disabled={genBusy === kind || !llmReady} onClick={() => genDraft(kind, !!d)}>
                    {genBusy === kind ? "writing…" : d ? "↻ rewrite" : "write it"}
                  </button>
                </div>
              </div>
              {d?.text ? <p className="draft-text">{d.text}</p> : <div className="gen-empty">Not written yet.</div>}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function fileNameOf(p: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}
