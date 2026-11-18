"use client";

import { useState } from "react";
import type { LevelBand, RemoteGeo, ResumeDraft, RoleArchetype, StoredFile } from "@jobflow/core";

/**
 * Onboarding: your résumé → a DRAFT you review → preferences → discovery preset. Nothing
 * reaches your profile until the final step, and only what you kept (invariant #3: the
 * Evidence Bank holds only claims from your own material).
 */

const PRESETS = [
  { id: "india", label: "India", detail: "Indian product companies, India offices of global firms, India job boards" },
  { id: "global-remote", label: "Global remote", detail: "Remote-first companies and remote boards, any country" },
  { id: "us", label: "United States", detail: "US companies on Greenhouse / Lever / Ashby + US aggregators" },
  { id: "eu-uk", label: "Europe & UK", detail: "EU/UK companies and boards (Arbeitnow, Adzuna GB/DE…)" },
];
const ARCHETYPES: RoleArchetype[] = ["backend", "platform", "fullstack", "infra_devops", "data_ml", "frontend", "mobile", "sre"];
const LEVELS: LevelBand[] = ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "manager", "director"];
const GEOS: { id: RemoteGeo; label: string }[] = [
  { id: "worldwide", label: "worldwide" },
  { id: "us_only", label: "US-only" },
  { id: "eu_only", label: "EU-only" },
  { id: "us_eu", label: "US/EU" },
  { id: "india_ok", label: "India OK" },
  { id: "apac_ok", label: "APAC OK" },
];
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD"];

type Step = "resume" | "review" | "prefs" | "discovery";
const STEP_LABEL: Record<Step, string> = { resume: "Your résumé", review: "Check what we found", prefs: "What you want", discovery: "Where to look" };

const EU = new Set(["GB", "DE", "FR", "NL", "IE", "ES", "IT", "PT", "SE", "DK", "FI", "NO", "PL", "AT", "BE", "CH", "CZ", "RO", "GR", "HU", "EE", "LT", "LV"]);
/** presets that fit a home country (always plus global remote) — a suggestion the user can change */
function presetsFor(country: string): string[] {
  const c = country.trim().toUpperCase();
  const local = c === "IN" ? "india" : c === "US" || c === "CA" ? "us" : EU.has(c) ? "eu-uk" : null;
  return local ? [local, "global-remote"] : ["global-remote"];
}
/** remote regions someone in this country can usually take */
function geosFor(country: string): RemoteGeo[] {
  const c = country.trim().toUpperCase();
  if (c === "US") return ["worldwide", "us_only", "us_eu"];
  if (EU.has(c)) return ["worldwide", "eu_only", "us_eu"];
  if (c === "IN") return ["worldwide", "india_ok", "apac_ok"];
  return ["worldwide"];
}

export function OnboardingWizard({ llmReady }: { llmReady: boolean }) {
  const [step, setStep] = useState<Step>("resume");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [assist, setAssist] = useState(false);
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  const [file, setFile] = useState<StoredFile | null>(null);

  // review state (seeded from the draft, edited by you)
  const [contact, setContact] = useState({ firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "" });
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");
  const [yoe, setYoe] = useState(0);
  const [level, setLevel] = useState<LevelBand>("mid");
  const [keep, setKeep] = useState<boolean[]>([]);

  // preferences
  const [homeCountry, setHomeCountry] = useState("");
  const [markets, setMarkets] = useState("");
  const [geos, setGeos] = useState<RemoteGeo[]>(["worldwide"]);
  const [relocate, setRelocate] = useState(false);
  const [floor, setFloor] = useState(0);
  const [currency, setCurrency] = useState("USD");
  const [archetypes, setArchetypes] = useState<RoleArchetype[]>([]);
  const [locations, setLocations] = useState("remote");
  const [presets, setPresets] = useState<string[]>(["global-remote"]);
  const [presetsTouched, setPresetsTouched] = useState(false);
  const [geosTouched, setGeosTouched] = useState(false);

  /** home country → suggested markets, remote regions and presets (until the user changes them) */
  function setHome(v: string) {
    const c = v.toUpperCase();
    setHomeCountry(c);
    if (/^[A-Z]{2}$/.test(c)) {
      if (!markets.trim()) setMarkets(c);
      if (!geosTouched) setGeos(geosFor(c));
      if (!presetsTouched) setPresets(presetsFor(c));
    }
  }

  function seedFromDraft(d: ResumeDraft) {
    setDraft(d);
    const name = (d.contact.firstName ?? "") + " " + (d.contact.lastName ?? "");
    setContact({
      firstName: d.contact.firstName ?? "",
      lastName: d.contact.lastName ?? "",
      email: d.contact.email ?? "",
      phone: d.contact.phone ?? "",
      linkedin: d.contact.linkedin ?? "",
      github: d.contact.github ?? "",
      portfolio: d.contact.portfolio ?? "",
    });
    void name;
    setSkills(d.skills.canonical);
    setYoe(Math.round(d.yoe.value * 10) / 10);
    setLevel(d.levelBand.value);
    setKeep(d.evidence.map((e) => e.selected));
    setArchetypes(d.archetypes.filter((a) => a !== "other"));
    if (d.locations[0]) setLocations(["remote", ...d.locations.map((l) => l.toLowerCase())].join(", "));
  }

  /** no résumé to hand: type the essentials instead (skills are the minimum to rank against) */
  function startManual() {
    setDraft(null);
    setFile(null);
    setError(null);
    setStep("review");
  }

  async function upload(f: File | null) {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`/api/resume/import${assist ? "?assist=1" : ""}`, { method: "POST", body: fd });
      const body = await res.json();
      if (!res.ok)
        throw new Error(`${body.error ?? "Couldn't read that file."} Try a PDF with selectable text or a DOCX — or paste the text below.`);
      setFile(body.file);
      seedFromDraft(body.draft);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function usePaste() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resume/import${assist ? "?assist=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: paste }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read that text.");
      setFile(null);
      seedFromDraft(body.draft);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadSample() {
    setBusy(true);
    await fetch("/api/onboarding/sample", { method: "POST" });
    window.location.href = "/?welcome=sample";
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const locationWeights = locations
        .split(",")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
        .map((label, i) => ({ label, weight: Math.max(0.5, 1 - i * 0.1) }));
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft,
          file,
          mode: "replace",
          acceptEvidence: keep.flatMap((k, i) => (k ? [i] : [])),
          contact,
          yoe,
          levelBand: level,
          stackProfile: skills,
          discoveryPresets: presets,
          prefs: {
            homeCountry: homeCountry.trim().toUpperCase(),
            markets: markets.split(",").map((m) => m.trim().toUpperCase()).filter((m) => /^[A-Z]{2}$/.test(m)),
            remoteGeoOk: geos,
            relocate,
            salaryFloor: floor,
            currency,
            targetArchetypes: archetypes,
            locationWeights,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't save your profile.");
      window.location.href = "/?welcome=1";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="settings onboarding">
      <ol className="onb-steps" aria-label="Setup steps">
        {(["resume", "review", "prefs", "discovery"] as Step[]).map((s, i) => (
          <li key={s} data-on={s === step} aria-current={s === step ? "step" : undefined}>
            {i + 1}. {STEP_LABEL[s]}
          </li>
        ))}
      </ol>
      <p className="hint">Nothing is saved until the last step. You can change all of it later under Profile.</p>
      {error && <p className="auth-error" role="alert">{error}</p>}

      {step === "resume" && (
        <section className="card-block">
          <h3>
            Your résumé <span className="hint">— PDF, DOCX, LaTeX, Markdown, text, JSON Resume or a LinkedIn data export</span>
          </h3>
          <p className="hint">
            JobFlow copies what&apos;s in your file — it never adds claims. You&apos;ll review everything before it&apos;s saved.
          </p>
          <div className="field-row">
            <label>
              upload
              <input type="file" accept=".pdf,.docx,.tex,.md,.txt,.json,.zip,.csv" disabled={busy} onChange={(e) => upload(e.target.files?.[0] ?? null)} />
            </label>
            <label className="onb-inline" title={llmReady ? "" : "Set a generation model in Settings first"}>
              <input type="checkbox" checked={assist} disabled={!llmReady} onChange={(e) => setAssist(e.target.checked)} />
              <span>also use my model to improve extraction (still only keeps what&apos;s in the file)</span>
            </label>
          </div>
          <p className="hint" style={{ marginTop: 14 }}>or paste the text:</p>
          <textarea className="onb-paste" rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste your résumé…" />
          <div className="onb-actions">
            <button type="button" className="save" disabled={busy || !paste.trim()} onClick={usePaste}>
              {busy ? "reading…" : "Read pasted text"}
            </button>
            <button type="button" className="save ghost" disabled={busy} onClick={startManual}>
              No résumé handy — type my skills instead
            </button>
            <button type="button" className="save ghost" disabled={busy} onClick={loadSample} title="Alex Example — invented, for trying JobFlow out">
              Just exploring — use a fictional sample
            </button>
          </div>
          {busy && <p className="hint" role="status">Reading your résumé…</p>}
        </section>
      )}

      {step === "review" && (
        <>
          {!draft && (
            <p className="hint">
              Without a résumé, JobFlow ranks jobs on your skills and level alone, and drafts can only use what you type here. You can upload one
              later under Profile.
            </p>
          )}
          {draft && draft.warnings.length > 0 && (
            <section className="card-block danger">
              <h3>Heads-up</h3>
              <ul className="onb-warnings">
                {draft.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="card-block">
            <h3>Contact <span className="hint">— only what you keep here is ever typed into a form, and the filler always stops at review</span></h3>
            <div className="field-row">
              {(Object.keys(contact) as (keyof typeof contact)[]).map((k) => (
                <label key={k}>
                  {k}
                  <input value={contact[k]} onChange={(e) => setContact({ ...contact, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </section>
          <section className="card-block">
            <h3>Skills <span className="hint">— your stack drives stack-adjacency scoring</span></h3>
            <div className="chip-row">
              {skills.map((s) => (
                <button key={s} type="button" className="chip" data-on="true" onClick={() => setSkills(skills.filter((x) => x !== s))}>
                  {s} ✕
                </button>
              ))}
              {(draft?.skills.unrecognized ?? []).slice(0, 20).map((s) => (
                <button key={`u-${s}`} type="button" className="chip" title="not in the skill dictionary — add as custom" onClick={() => setSkills([...skills, s.toLowerCase()])}>
                  + {s}
                </button>
              ))}
            </div>
            <div className="field-row" style={{ marginTop: 10 }}>
              <label>
                add skill
                <input
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && skillInput.trim()) {
                      e.preventDefault();
                      setSkills([...new Set([...skills, skillInput.trim().toLowerCase()])]);
                      setSkillInput("");
                    }
                  }}
                />
              </label>
              <label>
                years of experience <span className="hint">{draft?.yoe.basis}</span>
                <input type="number" min={0} max={60} step={0.5} value={yoe} onChange={(e) => setYoe(Number(e.target.value))} />
              </label>
              <label>
                level
                <select value={level} onChange={(e) => setLevel(e.target.value as LevelBand)}>
                  {LEVELS.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          {draft && (
          <section className="card-block">
            <h3>
              Evidence Bank <span className="hint">— the claims tailoring may cite; each is copied verbatim from your résumé</span>
            </h3>
            {draft.evidence.length === 0 && <p className="hint">No bullet points found — you can add evidence later under Profile.</p>}
            <ul className="onb-evidence">
              {draft.evidence.map((e, i) => (
                <li key={i}>
                  <label className="onb-inline">
                    <input type="checkbox" checked={keep[i] ?? false} onChange={() => setKeep(keep.map((k, j) => (j === i ? !k : k)))} />
                    <span>
                      <b>{e.project}</b> — {e.headline}
                      {e.metric && <span className="hint"> · {e.metric}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
          )}
          <div className="onb-actions">
            <button type="button" className="save ghost" onClick={() => setStep("resume")}>
              back
            </button>
            <button
              type="button"
              className="save"
              disabled={!draft && skills.length === 0}
              title={!draft && skills.length === 0 ? "Add at least one skill — there's nothing to rank jobs against otherwise" : ""}
              onClick={() => setStep("prefs")}
            >
              Looks right — next
            </button>
          </div>
        </>
      )}

      {step === "prefs" && (
        <>
          <section className="card-block">
            <h3>Where you work <span className="hint">— weighted signals, not filters: nothing is hidden for being elsewhere</span></h3>
            <div className="field-row">
              <label>
                home country (ISO code)
                <input value={homeCountry} maxLength={2} placeholder="e.g. US, DE, IN" onChange={(e) => setHome(e.target.value)} />
              </label>
              <label>
                markets to search
                <input value={markets} placeholder="e.g. US, CA" onChange={(e) => setMarkets(e.target.value)} />
              </label>
              <label>
                preferred locations, best first
                <input value={locations} onChange={(e) => setLocations(e.target.value)} />
              </label>
              <label className="onb-inline">
                <input type="checkbox" checked={relocate} onChange={(e) => setRelocate(e.target.checked)} />
                <span>open to relocating</span>
              </label>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>Remote roles you can take:</p>
            <div className="chip-row">
              {GEOS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="chip"
                  data-on={geos.includes(g.id)}
                  onClick={() => {
                    setGeosTouched(true);
                    setGeos(toggle(geos, g.id));
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </section>
          <section className="card-block">
            <h3>Pay & roles <span className="hint">— only a confidently-stated salary below your floor is excluded</span></h3>
            <div className="field-row">
              <label>
                salary floor (yearly)
                <input type="number" min={0} value={floor} onChange={(e) => setFloor(Number(e.target.value))} />
              </label>
              <label>
                currency
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>Role types you want:</p>
            <div className="chip-row">
              {ARCHETYPES.map((a) => (
                <button key={a} type="button" className="chip" data-on={archetypes.includes(a)} onClick={() => setArchetypes(toggle(archetypes, a))}>
                  {a}
                </button>
              ))}
            </div>
          </section>
          <div className="onb-actions">
            <button type="button" className="save ghost" onClick={() => setStep(draft ? "review" : "resume")}>
              back
            </button>
            <button type="button" className="save" onClick={() => setStep("discovery")}>
              Next — where to look
            </button>
          </div>
        </>
      )}

      {step === "discovery" && (
        <>
          <section className="card-block">
            <h3>Where to look <span className="hint">— pick one or more starting sets of companies and boards; add your own anytime under Sources</span></h3>
            {homeCountry && !presetsTouched && <p className="hint">Suggested from your home country ({homeCountry}). Pick as many as you like.</p>}
            <div className="onb-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="onb-preset"
                  data-on={presets.includes(p.id)}
                  onClick={() => {
                    setPresetsTouched(true);
                    setPresets(presets.includes(p.id) ? (presets.length > 1 ? presets.filter((x) => x !== p.id) : presets) : [...presets, p.id]);
                  }}
                >
                  <b>{p.label}</b>
                  <span className="hint">{p.detail}</span>
                </button>
              ))}
            </div>
          </section>
          <div className="onb-actions">
            <button type="button" className="save ghost" onClick={() => setStep("prefs")}>
              back
            </button>
            <button type="button" className="save" disabled={busy} onClick={finish}>
              {busy ? "saving…" : "Finish — find my jobs"}
            </button>
          </div>
          <p className="hint">Next: JobFlow fetches jobs from these boards (a minute or two the first time) and ranks every one against you.</p>
        </>
      )}
    </div>
  );
}
