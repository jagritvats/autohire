"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ResumeVariants } from "@jobflow/llm";
import { printableResumeHtml } from "@/lib/markdownDoc";

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

type VariantKey = "yc_startup" | "enterprise" | "product";
type Fmt = "bullets" | "markdown" | "latex";
type Msg = { text: string; detail?: string; ok?: boolean };

const ANSWER_FIELD: Record<string, string> = {
  why_here: "why do you want to work here",
  interesting_problem: "interesting problem",
};
const ANSWER_SECTIONS: { kind: string; title: string; blurb: string }[] = [
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
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [variant, setVariant] = useState<VariantKey>("yc_startup");
  const [fmt, setFmt] = useState<Fmt>("bullets");
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const [latexLog, setLatexLog] = useState<string | null>(null);

  // single in-flight action (user-initiated one at a time) + live elapsed + abort
  const [busy, setBusy] = useState<{ key: string; label: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const setMsg = (scope: string, text: string, detail?: string, ok?: boolean) =>
    setMsgs((m) => ({ ...m, [scope]: { text, detail, ok } }));

  // hydrate answer drafts from localStorage (survives dev restarts)
  useEffect(() => {
    setDrafts((cur) => {
      const next = { ...cur };
      for (const { kind } of ANSWER_SECTIONS) {
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

  /** run an async action with a live elapsed timer + cancel; AbortError is expected, not an error. */
  const run = async <T,>(key: string, label: string, fn: (signal: AbortSignal, setLabel: (l: string) => void) => Promise<T>): Promise<T | undefined> => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy({ key, label });
    setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    try {
      return await fn(ac.signal, (l) => setBusy({ key, label: l }));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return undefined; // cancelled
      throw e;
    } finally {
      clearInterval(timer);
      setBusy((b) => (b?.key === key ? null : b));
      abortRef.current = null;
    }
  };
  const cancel = () => abortRef.current?.abort();

  /** POST /api/generate for any kind; stores the draft + mirrors to localStorage. Throws {message, detail}. */
  const fetchGenerate = async (kind: string, force: boolean, signal: AbortSignal): Promise<Draft> => {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, kind, force }),
      signal,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      const err = new Error(b.error ?? "Generation failed.") as Error & { detail?: string };
      err.detail = b.detail;
      throw err;
    }
    const draft = (await res.json()) as Draft;
    setDrafts((cur) => ({ ...cur, [kind]: draft }));
    try {
      localStorage.setItem(lsKey(posting.id, kind), JSON.stringify(draft));
    } catch {
      /* quota / private mode */
    }
    return draft;
  };

  const generate = (kind: string, force: boolean) =>
    run(kind, force ? "regenerating…" : "generating…", async (signal) => {
      try {
        const d = await fetchGenerate(kind, force, signal);
        setMsg(kind, `${d.cached ? "cached" : "fresh"} · ${d.model}`, undefined, true);
      } catch (e) {
        setMsg(kind, (e as Error).message, (e as Error & { detail?: string }).detail);
      }
    });

  const compilePdf = (save: boolean) =>
    run(save ? "pdf-save" : "pdf", "compiling PDF…", async (signal, setLabel) => {
      setLatexLog(null);
      try {
        if (!drafts["resume_latex"]?.text) {
          setLabel("generating .tex…");
          await fetchGenerate("resume_latex", false, signal);
          setLabel("compiling PDF…");
        }
        const res = await fetch("/api/resume/pdf", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ postingId: posting.id, save }),
          signal,
        });
        if (res.headers.get("content-type")?.includes("application/pdf")) {
          downloadBlob(await res.blob(), "tailored-resume.pdf");
          setMsg("latex", save ? "Saved the tailored PDF + set it as this application's attachment." : `PDF compiled via ${res.headers.get("x-latex-engine") || "local engine"}.`, undefined, true);
        } else {
          const b = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; log?: string; noEngine?: boolean; latex?: string };
          setMsg("latex", (b.error ?? "Compile failed.") + (b.noEngine ? " Download the .tex and compile in Overleaf." : ""), b.detail);
          if (b.log) setLatexLog(b.log);
        }
      } catch (e) {
        setMsg("latex", (e as Error).message, (e as Error & { detail?: string }).detail);
      }
    });

  const answerText = (kind: string) => texts[kind] ?? drafts[kind]?.text ?? "";

  const saveToApplication = () =>
    run("app-save", "saving…", async (signal) => {
      try {
        const answers: Record<string, string> = {};
        for (const kind of Object.keys(ANSWER_FIELD)) {
          const t = answerText(kind).trim();
          if (t) answers[ANSWER_FIELD[kind]!] = t;
        }
        await fetch("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postingId: posting.id, status: "saved" }), signal });
        const res = await fetch("/api/applications", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ postingId: posting.id, answers, resumeVariant: variant, status: "drafting" }),
          signal,
        });
        setMsg("app", res.ok ? `Saved to your application — ${Object.keys(answers).length} answer(s) + “${variant.replace("_", "/")}” variant.` : "Save to application failed.", undefined, res.ok);
      } catch (e) {
        setMsg("app", (e as Error).message);
      }
    });

  const fillViaAgent = () =>
    run("app-fill", "queuing…", async (signal) => {
      try {
        await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "form_fill", payload: { postingId: posting.id } }), signal });
        setMsg("app", "Queued a form-fill — your local agent pre-fills the form in your session with these answers and stops at review (never submits). Offline → it runs when the agent is back.", undefined, true);
      } catch (e) {
        setMsg("app", (e as Error).message);
      }
    });

  const printMarkdown = (md: string) => {
    const w = window.open("", "_blank", "width=820,height=1000");
    if (!w) return setMsg("md", "Pop-up blocked — allow pop-ups to Save-as-PDF, or use “download .md”.");
    w.document.write(printableResumeHtml(md, posting.company));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  };

  const isBusy = (key: string) => busy?.key === key;
  const latex = drafts["resume_latex"]?.text ?? "";
  const markdown = drafts["resume_md"]?.text ?? "";

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

      {/* ── tailored résumé: Bullets · Markdown · LaTeX ── */}
      <section className="card-block tailor-block">
        <div className="tailor-block-head">
          <div>
            <h3>Tailored résumé</h3>
            <span className="hint">grounded in your Evidence Bank — pick a format</span>
          </div>
          <div className="variant-tabs">
            {(["bullets", "markdown", "latex"] as Fmt[]).map((f) => (
              <button key={f} className="chip" data-on={fmt === f} onClick={() => setFmt(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {fmt === "bullets" && (
          <Pane
            empty={!drafts["resume"]?.variants}
            onGen={() => generate("resume", !!drafts["resume"])}
            busy={busy}
            elapsed={elapsed}
            genKey="resume"
            cancel={cancel}
            msg={msgs["resume"]}
          >
            {drafts["resume"]?.variants && <ResumeBlock variants={drafts["resume"]!.variants!} variant={variant} onVariant={setVariant} />}
          </Pane>
        )}

        {fmt === "markdown" && (
          <Pane
            empty={!markdown}
            onGen={() => generate("resume_md", !!markdown)}
            busy={busy}
            elapsed={elapsed}
            genKey="resume_md"
            cancel={cancel}
            msg={msgs["resume_md"]}
            hint="Common / plain-text résumé — no LaTeX needed. Download .md/.txt or Save-as-PDF via your browser."
          >
            {markdown && (
              <MarkdownBlock
                md={markdown}
                onPrint={() => printMarkdown(markdown)}
              />
            )}
          </Pane>
        )}

        {fmt === "latex" && (
          <Pane
            empty={!latex}
            onGen={() => generate("resume_latex", !!latex)}
            busy={busy}
            elapsed={elapsed}
            genKey="resume_latex"
            cancel={cancel}
            msg={msgs["latex"]}
            hint="Typeset .tex from your base template (or a built-in) — compile to PDF locally / Overleaf."
          >
            {latex && (
              <>
                <div className="latex-actions">
                  <button className="cmd" onClick={() => downloadBlob(new Blob([latex], { type: "application/x-tex" }), "tailored-resume.tex")}>
                    download .tex
                  </button>
                  <button className="cmd add" disabled={isBusy("pdf")} onClick={() => compilePdf(false)}>
                    {isBusy("pdf") ? `${busy?.label} ${elapsed}s` : "download PDF"}
                  </button>
                  <button className="cmd" disabled={isBusy("pdf-save")} onClick={() => compilePdf(true)}>
                    {isBusy("pdf-save") ? `${busy?.label} ${elapsed}s` : "use for autofill"}
                  </button>
                  {(isBusy("pdf") || isBusy("pdf-save")) && (
                    <button className="cmd danger" onClick={cancel}>
                      cancel
                    </button>
                  )}
                </div>
                <details className="src-preview">
                  <summary>peek .tex</summary>
                  <pre>{latex.slice(0, 4000)}</pre>
                </details>
              </>
            )}
            {latexLog && (
              <details className="src-preview">
                <summary>compiler log</summary>
                <pre>{latexLog}</pre>
              </details>
            )}
          </Pane>
        )}
      </section>

      {/* ── application answers ── */}
      {ANSWER_SECTIONS.map(({ kind, title, blurb }) => {
        const d = drafts[kind];
        return (
          <section className="card-block tailor-block" key={kind}>
            <div className="tailor-block-head">
              <div>
                <h3>{title}</h3>
                <span className="hint">{blurb}</span>
              </div>
              <div className="tailor-block-btns">
                {busy?.key === kind ? (
                  <span className="gen-meta">
                    {busy.label} {elapsed}s{" "}
                    <button className="cmd" onClick={cancel}>
                      cancel
                    </button>
                  </span>
                ) : (
                  <button className="cmd" onClick={() => generate(kind, !!d)}>
                    {d ? "↻ regenerate" : "generate"}
                  </button>
                )}
              </div>
            </div>
            {d?.text && <AnswerBlock text={d.text} onChange={(t) => setTexts((s) => ({ ...s, [kind]: t }))} />}
            {!d && busy?.key !== kind && <div className="gen-empty">Not generated yet.</div>}
            <MsgLine msg={msgs[kind]} />
          </section>
        );
      })}

      {/* ── save + fill ── */}
      <section className="card-block tailor-footer">
        <div className="tailor-footer-row">
          <button className="save ghost" disabled={isBusy("app-save")} onClick={saveToApplication}>
            {isBusy("app-save") ? `${busy?.label} ${elapsed}s` : "Save to application"}
          </button>
          <button className="cmd" disabled={isBusy("app-fill")} onClick={fillViaAgent}>
            {isBusy("app-fill") ? `${busy?.label} ${elapsed}s` : "Fill via local agent →"}
          </button>
        </div>
        <p className="hint">
          “Save” attaches your edited answers + chosen variant to this role’s application. “Fill” hands it to your local
          agent, which pre-fills the form in your own browser and <strong>stops at review</strong> — it never submits.
          For the attachment, compile a PDF under <strong>LaTeX → use for autofill</strong> (else your base résumé is used).
        </p>
        <MsgLine msg={msgs["app"]} />
      </section>
    </div>
  );
}

/** A generate/regenerate pane with progress, cancel, and a status line. */
function Pane({
  empty,
  onGen,
  busy,
  elapsed,
  genKey,
  cancel,
  msg,
  hint,
  children,
}: {
  empty: boolean;
  onGen: () => void;
  busy: { key: string; label: string } | null;
  elapsed: number;
  genKey: string;
  cancel: () => void;
  msg?: Msg;
  hint?: string;
  children?: ReactNode;
}) {
  const isBusy = busy?.key === genKey;
  return (
    <div className="pane">
      <div className="pane-head">
        {hint && <span className="hint">{hint}</span>}
        <div className="pane-btns">
          {isBusy ? (
            <span className="gen-meta">
              {busy!.label} {elapsed}s{" "}
              <button className="cmd" onClick={cancel}>
                cancel
              </button>
            </span>
          ) : (
            <button className="cmd" onClick={onGen}>
              {empty ? "generate" : "↻ regenerate"}
            </button>
          )}
        </div>
      </div>
      {children}
      {empty && !isBusy && <div className="gen-empty">Not generated yet.</div>}
      <MsgLine msg={msg} />
    </div>
  );
}

function MsgLine({ msg }: { msg?: Msg }) {
  if (!msg) return null;
  return (
    <div className={msg.ok ? "tailor-app-msg" : "tailor-err"}>
      {msg.text}
      {msg.detail && (
        <details className="src-preview" style={{ marginTop: 6 }}>
          <summary>details</summary>
          <pre>{msg.detail}</pre>
        </details>
      )}
    </div>
  );
}

function ResumeBlock({ variants, variant, onVariant }: { variants: ResumeVariants; variant: VariantKey; onVariant: (v: VariantKey) => void }) {
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
          <span className="missing">surface: {variants.missingKeywords.slice(0, 6).map((k) => k.replace(/_/g, " ")).join(", ")}</span>
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

function MarkdownBlock({ md, onPrint }: { md: string; onPrint: () => void }) {
  return (
    <div className="md-block">
      <div className="latex-actions">
        <button className="cmd" onClick={() => downloadBlob(new Blob([md], { type: "text/markdown" }), "tailored-resume.md")}>
          download .md
        </button>
        <button className="cmd" onClick={() => downloadBlob(new Blob([md], { type: "text/plain" }), "tailored-resume.txt")}>
          download .txt
        </button>
        <button className="cmd add" onClick={onPrint}>
          Save as PDF ↧
        </button>
        <button className="copy" onClick={() => copy(md)}>
          copy
        </button>
      </div>
      <details className="src-preview" open>
        <summary>preview</summary>
        <pre>{md}</pre>
      </details>
    </div>
  );
}

function AnswerBlock({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const [val, setVal] = useState(text);
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
