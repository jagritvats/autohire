"use client";

import { useEffect, useState } from "react";
import type { ResumeVariants } from "@jobflow/llm";

/** Mirror of lib/tailor.ts GenerationDTO (kept local so this client file pulls no server code). */
export interface Draft {
  postingId: string | null;
  kind: string;
  prompt: string;
  variants: ResumeVariants | null;
  text: string;
  model: string;
  cached: boolean;
  createdAt: string;
}

export interface TailorPosting {
  id: string;
  title: string;
  company: string;
  companyId: string;
  applyUrl: string | null;
  skills: string[];
  location: string;
  level: string | null;
  llm: string;
}

type Kind = "resume" | "why_here" | "interesting_problem";
type VariantKey = "yc_startup" | "enterprise" | "product";
const ANSWER_FIELD: Record<string, string> = {
  why_here: "why do you want to work here",
  interesting_problem: "interesting problem",
};
const SECTIONS: { kind: Kind; title: string; blurb: string }[] = [
  { kind: "resume", title: "Tailored resume", blurb: "3 strategy variants, every bullet grounded in your Evidence Bank." },
  { kind: "why_here", title: "Why do you want to work here?", blurb: "Honest, specific — no name-dropping products you don't know." },
  { kind: "interesting_problem", title: "A unique / interesting problem you've solved", blurb: "Drawn from your real projects." },
];

const lsKey = (postingId: string, kind: string) => `jobflow:gen:${postingId}:${kind}`;

export function TailorView({ posting, initialDrafts }: { posting: TailorPosting; initialDrafts: Draft[] }) {
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>(() => {
    const m: Record<string, Draft | undefined> = {};
    for (const d of initialDrafts) m[d.kind] = d;
    return m;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // lifted so "Save to application" captures the user's edits + chosen variant
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [variant, setVariant] = useState<VariantKey>("yc_startup");
  const [appBusy, setAppBusy] = useState<string | null>(null);
  const [appMsg, setAppMsg] = useState<string | null>(null);
  // LaTeX résumé
  const [latex, setLatex] = useState<string | null>(null);
  const [latexBusy, setLatexBusy] = useState<string | null>(null);
  const [latexMsg, setLatexMsg] = useState<string | null>(null);
  const [latexLog, setLatexLog] = useState<string | null>(null);

  // hydrate from localStorage for kinds the server didn't have (survives dev restarts)
  useEffect(() => {
    setDrafts((cur) => {
      const next = { ...cur };
      for (const { kind } of SECTIONS) {
        if (next[kind]) continue;
        try {
          const raw = localStorage.getItem(lsKey(posting.id, kind));
          if (raw) next[kind] = JSON.parse(raw) as Draft;
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, [posting.id]);

  const generate = async (kind: Kind, force: boolean) => {
    setBusy(kind);
    setErr(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingId: posting.id, kind, force }),
      });
      if (!res.ok) {
        setErr((await res.json().catch(() => ({})))?.error ?? "Generation failed.");
        return;
      }
      const draft = (await res.json()) as Draft;
      setDrafts((cur) => ({ ...cur, [kind]: draft }));
      try {
        localStorage.setItem(lsKey(posting.id, kind), JSON.stringify(draft));
      } catch {
        /* quota / private mode — fine */
      }
    } finally {
      setBusy(null);
    }
  };

  const answerText = (kind: string) => texts[kind] ?? drafts[kind]?.text ?? "";

  const saveToApplication = async () => {
    setAppBusy("save");
    setAppMsg(null);
    const answers: Record<string, string> = {};
    for (const kind of Object.keys(ANSWER_FIELD)) {
      const t = answerText(kind).trim();
      if (t) answers[ANSWER_FIELD[kind]!] = t;
    }
    await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, status: "saved" }),
    });
    const res = await fetch("/api/applications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, answers, resumeVariant: variant, status: "drafting" }),
    });
    setAppBusy(null);
    setAppMsg(
      res.ok
        ? `Saved to your application — ${Object.keys(answers).length} answer(s) + “${variant.replace("_", "/")}” variant.`
        : "Save to application failed.",
    );
  };

  const genLatex = async (force: boolean) => {
    setLatexBusy("gen");
    setLatexMsg(null);
    setLatexLog(null);
    const res = await fetch("/api/resume/latex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, force }),
    });
    const body = await res.json().catch(() => ({}));
    setLatexBusy(null);
    if (!res.ok) return setLatexMsg(body.error ?? "LaTeX generation failed.");
    setLatex(body.latex);
    setLatexMsg(`LaTeX ready — ${body.cached ? "cached" : "fresh"} · ${body.model}.`);
  };

  const downloadPdf = async (save: boolean) => {
    setLatexBusy(save ? "save" : "pdf");
    setLatexMsg(null);
    setLatexLog(null);
    const res = await fetch("/api/resume/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, save }),
    });
    if (res.headers.get("content-type")?.includes("application/pdf")) {
      downloadBlob(await res.blob(), "tailored-resume.pdf");
      setLatexBusy(null);
      setLatexMsg(save ? "Saved the tailored PDF + set it as your autofill attachment." : `PDF compiled via ${res.headers.get("x-latex-engine") || "local engine"}.`);
    } else {
      const body = await res.json().catch(() => ({}));
      setLatexBusy(null);
      setLatexMsg((body.error ?? "Compile failed.") + (body.noEngine ? " Download the .tex and compile in Overleaf." : ""));
      if (body.log) setLatexLog(body.log);
      if (body.latex && !latex) setLatex(body.latex);
    }
  };

  const fillViaAgent = async () => {
    setAppBusy("fill");
    setAppMsg(null);
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "form_fill", payload: { postingId: posting.id } }),
    });
    setAppBusy(null);
    setAppMsg("Queued a form-fill — your local agent pre-fills the form in your session with these answers and stops at review (never submits). Offline → it runs when the agent is back.");
  };

  return (
    <div className="tailor">
      <div className="tailor-head">
        <div>
          <div className="tailor-role">{posting.title}</div>
          <div className="tailor-sub">
            <a href={`/company/${posting.companyId}`}>{posting.company}</a>
            <span className="dot">·</span>
            {posting.location}
            {posting.level ? <> · {posting.level}</> : null}
          </div>
        </div>
        <div className="tailor-actions">
          <span className="llm-pill">llm: {posting.llm}</span>
          {posting.applyUrl && (
            <a className="apply" href={posting.applyUrl} target="_blank" rel="noreferrer">
              Apply →
            </a>
          )}
        </div>
      </div>

      <p className="tailor-note">
        Evidence-grounded &amp; honest-voice — bullets and answers cite your real projects; nothing is invented.
        Drafts are cached (here &amp; locally); <strong>regenerate</strong> forces a fresh pass. Editing your profile
        invalidates stale drafts automatically.
      </p>

      {err && <div className="tailor-err">{err}</div>}

      {SECTIONS.map(({ kind, title, blurb }) => {
        const d = drafts[kind];
        return (
          <section className="card-block tailor-block" key={kind}>
            <div className="tailor-block-head">
              <div>
                <h3>{title}</h3>
                <span className="hint">{blurb}</span>
              </div>
              <div className="tailor-block-btns">
                {d && (
                  <span className="gen-meta">
                    {d.cached ? "cached" : "fresh"} · {d.model}
                  </span>
                )}
                <button className="cmd" disabled={busy === kind} onClick={() => generate(kind, !!d)}>
                  {busy === kind ? "generating…" : d ? "↻ regenerate" : "generate"}
                </button>
              </div>
            </div>
            {kind === "resume"
              ? d?.variants && <ResumeBlock variants={d.variants} variant={variant} onVariant={setVariant} />
              : d?.text && <AnswerBlock text={d.text} onChange={(t) => setTexts((s) => ({ ...s, [kind]: t }))} />}
            {!d && <div className="gen-empty">Not generated yet.</div>}
          </section>
        );
      })}

      <section className="card-block tailor-block">
        <div className="tailor-block-head">
          <div>
            <h3>LaTeX résumé</h3>
            <span className="hint">tailored .tex from your base template (or a built-in one) + evidence; compile to PDF locally</span>
          </div>
          <div className="tailor-block-btns">
            <button className="cmd" disabled={latexBusy === "gen"} onClick={() => genLatex(!!latex)}>
              {latexBusy === "gen" ? "generating…" : latex ? "↻ regenerate" : "generate LaTeX"}
            </button>
          </div>
        </div>
        {latex ? (
          <>
            <div className="latex-actions">
              <button className="cmd" onClick={() => downloadBlob(new Blob([latex], { type: "application/x-tex" }), "tailored-resume.tex")}>
                download .tex
              </button>
              <button className="cmd add" disabled={latexBusy === "pdf"} onClick={() => downloadPdf(false)}>
                {latexBusy === "pdf" ? "compiling…" : "download PDF"}
              </button>
              <button className="cmd" disabled={latexBusy === "save"} onClick={() => downloadPdf(true)}>
                {latexBusy === "save" ? "saving…" : "use for autofill"}
              </button>
            </div>
            <details className="src-preview">
              <summary>peek .tex</summary>
              <pre>{latex.slice(0, 4000)}</pre>
            </details>
          </>
        ) : (
          <div className="gen-empty">Not generated yet.</div>
        )}
        {latexMsg && <div className="tailor-app-msg">{latexMsg}</div>}
        {latexLog && (
          <details className="src-preview">
            <summary>compiler log</summary>
            <pre>{latexLog}</pre>
          </details>
        )}
      </section>

      <section className="card-block tailor-footer">
        <div className="tailor-footer-row">
          <button className="save ghost" disabled={appBusy === "save"} onClick={saveToApplication}>
            {appBusy === "save" ? "saving…" : "Save to application"}
          </button>
          <button className="cmd" disabled={appBusy === "fill"} onClick={fillViaAgent}>
            {appBusy === "fill" ? "queuing…" : "Fill via local agent →"}
          </button>
        </div>
        <p className="hint">
          “Save” attaches your edited answers + chosen variant to this role’s application. “Fill” hands it to your local
          agent, which pre-fills the form in your own browser and <strong>stops at review</strong> — it never submits.
          The attached file is your base résumé (<code>contact.resumePath</code>); tailored bullets are copy/answers.
        </p>
        {appMsg && <div className="tailor-app-msg">{appMsg}</div>}
      </section>
    </div>
  );
}

function ResumeBlock({
  variants,
  variant,
  onVariant,
}: {
  variants: ResumeVariants;
  variant: VariantKey;
  onVariant: (v: VariantKey) => void;
}) {
  const tabs: { key: VariantKey; label: string }[] = [
    { key: "yc_startup", label: "yc / startup" },
    { key: "enterprise", label: "enterprise" },
    { key: "product", label: "product" },
  ];
  const bullets = (variants[variant] as string[]) ?? [];

  return (
    <div className="resume-block">
      <div className="resume-meta">
        <span className="ats-cov">
          ATS coverage <b>{Math.round((variants.atsKeywordCoverage ?? 0) * 100)}%</b>
        </span>
        {variants.missingKeywords?.length > 0 && (
          <span className="missing">
            surface: {variants.missingKeywords.slice(0, 6).map((k) => k.replace(/_/g, " ")).join(", ")}
          </span>
        )}
        <button className="copy" onClick={() => copy(bullets.map((b) => `• ${b}`).join("\n"))}>
          copy
        </button>
      </div>
      <div className="variant-tabs">
        {tabs.map((t) => (
          <button key={t.key} className="chip" data-on={variant === t.key} onClick={() => onVariant(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <ul className="bullets">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

function AnswerBlock({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const [val, setVal] = useState(text);
  // re-sync when a regenerate brings new text (and lift it so the parent can save it)
  useEffect(() => {
    setVal(text);
    onChange(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const update = (t: string) => {
    setVal(t);
    onChange(t);
  };
  return (
    <div className="answer-block">
      <textarea className="answer-text" value={val} onChange={(e) => update(e.target.value)} rows={6} />
      <div className="answer-foot">
        <span className="hint">{val.trim().split(/\s+/).filter(Boolean).length} words · editable before you copy</span>
        <button className="copy" onClick={() => copy(val)}>
          copy
        </button>
      </div>
    </div>
  );
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
