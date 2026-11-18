"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ResumeVariants } from "@jobflow/llm";
import { printableLetterHtml, printableResumeHtml } from "@/lib/markdownDoc";

/** Mirror of lib/tailor.ts GenerationDTO (kept local so this client file pulls no server code). */
export interface Draft {
  postingId: string | null;
  kind: string;
  prompt: string;
  variants: ResumeVariants | null;
  text: string;
  note: string;
  model: string;
  source: "llm" | "builtin";
  edited: boolean;
  stale: boolean;
  warnings: string[];
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

/** What tailoring grounds on — computed server-side so thin inputs are visible up front. */
export interface TailorInputs {
  name: string;
  hasEmail: boolean;
  resumeChars: number;
  hasLatex: boolean;
  aboutChars: number;
  skills: number;
  evidence: number;
  sampleEvidence: number;
  offline: boolean;
  texEngine: string | null;
}

type VariantKey = "yc_startup" | "enterprise" | "product";
type Fmt = "markdown" | "latex" | "bullets";
type Msg = { text: string; detail?: string; tone: "ok" | "warn" | "err" };
type Busy = { key: string; label: string } | null;

/** mirror of COVER_LETTER_ANSWER_KEY in @jobflow/core — where the agent looks for the letter */
const COVER_LETTER_KEY = "cover letter";
const ANSWER_FIELD: Record<string, string> = {
  why_here: "why do you want to work here",
  interesting_problem: "interesting problem",
};
const ANSWER_SECTIONS: { kind: string; title: string; blurb: string }[] = [
  { kind: "why_here", title: "Why do you want to work here?", blurb: "Honest, specific — no name-dropping products you don't know." },
  { kind: "interesting_problem", title: "A unique / interesting problem you've solved", blurb: "Drawn from your real projects." },
];
const lsKey = (postingId: string, kind: string) => `jobflow:gen:${postingId}:${kind}`;

export function TailorView({ posting, inputs, initialDrafts }: { posting: TailorPosting; inputs: TailorInputs; initialDrafts: Draft[] }) {
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>(() => {
    const m: Record<string, Draft | undefined> = {};
    for (const d of initialDrafts) m[d.kind] ??= d; // newest first
    return m;
  });
  const [texts, setTexts] = useState<Record<string, string>>({}); // unsaved edits, by kind
  const [variant, setVariant] = useState<VariantKey>("yc_startup");
  const [fmt, setFmt] = useState<Fmt>(inputs.hasLatex ? "latex" : "markdown");
  const [note, setNote] = useState(() => initialDrafts.find((d) => d.kind === "cover_letter")?.note ?? "");
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const [latexLog, setLatexLog] = useState<string | null>(null);
  const [pdf, setPdf] = useState<{ url: string; blob: Blob; forText: string } | null>(null);
  const mdFrame = useRef<HTMLIFrameElement>(null);
  const letterFrame = useRef<HTMLIFrameElement>(null);

  // single in-flight action (user-initiated one at a time) + live elapsed + abort
  const [busy, setBusy] = useState<Busy>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const setMsg = (scope: string, text: string, tone: Msg["tone"], detail?: string) => setMsgs((m) => ({ ...m, [scope]: { text, detail, tone } }));

  // hydrate answer drafts from localStorage (survives in-memory dev restarts)
  useEffect(() => {
    setDrafts((cur) => {
      const next = { ...cur };
      for (const { kind } of ANSWER_SECTIONS) {
        if (next[kind]) continue;
        try {
          const raw = localStorage.getItem(lsKey(posting.id, kind));
          const d = raw ? (JSON.parse(raw) as Draft) : null;
          if (d?.text && !d.text.startsWith("[echo:")) next[kind] = d;
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, [posting.id]);

  // release the PDF preview's object URL when it's replaced / on unmount
  useEffect(() => () => void (pdf && URL.revokeObjectURL(pdf.url)), [pdf]);

  const fileBase = (what: "Resume" | "Cover_Letter") =>
    [inputs.name, what, posting.company].filter(Boolean).join("_").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");

  const textOf = (kind: string) => texts[kind] ?? drafts[kind]?.text ?? "";
  const isDirty = (kind: string) => texts[kind] !== undefined && texts[kind] !== (drafts[kind]?.text ?? "");
  const edit = (kind: string, t: string) => setTexts((s) => ({ ...s, [kind]: t }));
  const dropEdit = (kind: string) =>
    setTexts((s) => {
      const n = { ...s };
      delete n[kind];
      return n;
    });

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
  const isBusy = (key: string) => busy?.key === key;

  /** POST /api/generate for any kind; stores the draft. Throws {message, detail}. */
  const fetchGenerate = async (kind: string, force: boolean, signal: AbortSignal): Promise<Draft> => {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, kind, force, ...(kind === "cover_letter" ? { note } : {}) }),
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
    dropEdit(kind);
    if (ANSWER_FIELD[kind]) {
      try {
        localStorage.setItem(lsKey(posting.id, kind), JSON.stringify(draft));
      } catch {
        /* quota / private mode */
      }
    }
    return draft;
  };

  const generate = (kind: string, force: boolean) => {
    if (force && (drafts[kind]?.edited || isDirty(kind)) && !window.confirm("Regenerate and replace your edited version?")) return;
    const slow = kind === "resume_latex" || kind === "resume_md" ? " (can take a minute or two)" : "";
    return run(kind, `${force ? "regenerating" : "generating"}${slow}…`, async (signal) => {
      try {
        const d = await fetchGenerate(kind, force, signal);
        if (d.warnings.length) setMsg(kind, d.warnings.join(" "), "warn");
        else setMsg(kind, `${d.cached ? "cached" : "fresh"} · ${d.model}`, "ok");
      } catch (e) {
        setMsg(kind, (e as Error).message, "err", (e as Error & { detail?: string }).detail);
      }
    });
  };

  /** Persist an edited draft (on blur / before exporting). Quiet unless it fails. */
  const saveEdit = async (kind: string) => {
    if (!isDirty(kind) || !drafts[kind]) return;
    const text = texts[kind]!;
    const res = await fetch("/api/generate", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, kind, text }),
    }).catch(() => null);
    if (!res?.ok) return setMsg(kind, "Couldn't save your edit — it's still here; try again before leaving.", "err");
    const d = (await res.json()) as Draft;
    setDrafts((cur) => ({ ...cur, [kind]: d }));
    setTexts((s) => (s[kind] === text ? (({ [kind]: _, ...rest }) => rest)(s) : s));
  };

  /** Compile LaTeX or Markdown to PDF on the server; returns the PDF or null (message set). */
  const compile = async (scope: string, source: { latex: string } | { markdown: string }, save: boolean, signal: AbortSignal): Promise<Blob | null> => {
    setLatexLog(null);
    const res = await fetch("/api/resume/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postingId: posting.id, save, ...source }),
      signal,
    });
    if (res.headers.get("content-type")?.includes("application/pdf")) {
      const engine = res.headers.get("x-latex-engine") || "local engine";
      if (save) {
        setMsg(
          scope,
          res.headers.get("x-saved")
            ? `Compiled with ${engine} and attached to this application — the local agent uploads this PDF.`
            : "Compiled, but couldn't attach it to the application (see the server log).",
          res.headers.get("x-saved") ? "ok" : "warn",
        );
      } else setMsg(scope, `Compiled with ${engine}.`, "ok");
      return res.blob();
    }
    const b = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; log?: string; noEngine?: boolean };
    setMsg(scope, (b.error ?? "Compile failed.") + (b.noEngine ? " Download the .tex and compile it in Overleaf." : ""), "err", b.detail);
    if (b.log) setLatexLog(b.log);
    return null;
  };

  const compileLatex = (mode: "preview" | "download" | "save") =>
    run(`pdf-${mode}`, "compiling…", async (signal, setLabel) => {
      try {
        let tex = textOf("resume_latex");
        if (!tex) {
          setLabel("generating .tex…");
          tex = (await fetchGenerate("resume_latex", false, signal)).text;
          setLabel("compiling…");
        }
        void saveEdit("resume_latex");
        const blob = await compile("resume_latex", { latex: tex }, mode === "save", signal);
        if (!blob) return;
        setPdf({ url: URL.createObjectURL(blob), blob, forText: tex });
        if (mode === "download") downloadBlob(blob, `${fileBase("Resume")}.pdf`);
      } catch (e) {
        setMsg("resume_latex", (e as Error).message, "err", (e as Error & { detail?: string }).detail);
      }
    });

  const downloadLatexPdf = () => {
    if (pdf && pdf.forText === textOf("resume_latex")) downloadBlob(pdf.blob, `${fileBase("Resume")}.pdf`);
    else void compileLatex("download");
  };

  const compileMarkdown = (save: boolean) =>
    run(save ? "md-save" : "md-pdf", "typesetting…", async (signal) => {
      try {
        void saveEdit("resume_md");
        const blob = await compile("resume_md", { markdown: textOf("resume_md") }, save, signal);
        if (blob && !save) downloadBlob(blob, `${fileBase("Resume")}.pdf`);
      } catch (e) {
        setMsg("resume_md", (e as Error).message, "err");
      }
    });

  const printFrame = (ref: RefObject<HTMLIFrameElement>, scope: string) => {
    const w = ref.current?.contentWindow;
    if (!w) return setMsg(scope, "The preview isn't ready yet.", "err");
    w.focus();
    w.print();
  };

  const saveToApplication = () =>
    run("app-save", "saving…", async (signal) => {
      try {
        const answers: Record<string, string> = {};
        for (const kind of Object.keys(ANSWER_FIELD)) {
          const t = textOf(kind).trim();
          if (t) answers[ANSWER_FIELD[kind]!] = t;
        }
        const letter = textOf("cover_letter").trim();
        if (letter) answers[COVER_LETTER_KEY] = letter;
        await Promise.all([...Object.keys(ANSWER_FIELD), "cover_letter"].map(saveEdit));
        await fetch("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postingId: posting.id, status: "saved" }), signal });
        const res = await fetch("/api/applications", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ postingId: posting.id, answers, resumeVariant: variant, status: "drafting" }),
          signal,
        });
        const parts = [`${Object.keys(answers).length - (letter ? 1 : 0)} answer(s)`, letter ? "the cover letter" : "", `the “${variant.replace("_", "/")}” variant`].filter(Boolean);
        setMsg("app", res.ok ? `Saved to your application — ${parts.join(", ")}.` : "Save to application failed.", res.ok ? "ok" : "err");
      } catch (e) {
        setMsg("app", (e as Error).message, "err");
      }
    });

  const fillViaAgent = () =>
    run("app-fill", "queuing…", async (signal) => {
      try {
        await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "form_fill", payload: { postingId: posting.id } }), signal });
        setMsg("app", "Queued a form-fill — your local agent pre-fills the form in your session with these answers and stops at review (never submits). Offline → it runs when the agent is back.", "ok");
      } catch (e) {
        setMsg("app", (e as Error).message, "err");
      }
    });

  const markdown = textOf("resume_md");
  const latex = textOf("resume_latex");
  const letter = textOf("cover_letter");
  const mdPreview = useDeferredValue(markdown);
  const letterPreview = useDeferredValue(letter);
  const mdHtml = useMemo(() => printableResumeHtml(mdPreview, fileBase("Resume")), [mdPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  const letterHtml = useMemo(() => printableLetterHtml(letterPreview, fileBase("Cover_Letter")), [letterPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  const noEngineTitle = inputs.texEngine ? undefined : "Needs a local LaTeX engine (tectonic / MiKTeX / TeX Live).";

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

      <InputsStrip inputs={inputs} />

      {/* ── tailored résumé: Markdown · LaTeX · Bullets ── */}
      <section className="card-block tailor-block">
        <div className="tailor-block-head">
          <div>
            <h2>Tailored résumé</h2>
            <span className="hint">your résumé, rewritten for this role — edit the source, check the preview, export</span>
          </div>
          <div className="variant-tabs">
            {(["markdown", "latex", "bullets"] as Fmt[]).map((f) => (
              <button key={f} className="chip" data-on={fmt === f} onClick={() => setFmt(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {fmt === "markdown" && (
          <Pane
            genKey="resume_md"
            draft={drafts["resume_md"]}
            empty={!markdown}
            onGen={() => generate("resume_md", !!drafts["resume_md"])}
            busy={busy}
            elapsed={elapsed}
            cancel={cancel}
            msg={msgs["resume_md"]}
            hint="Plain-format résumé — no LaTeX needed. “Save as PDF” prints the preview; “typeset PDF” builds a proper PDF you can attach for autofill."
          >
            {markdown && (
              <>
                <div className="latex-actions">
                  <button className="cmd" onClick={() => downloadBlob(new Blob([markdown], { type: "text/markdown" }), `${fileBase("Resume")}.md`)}>
                    download .md
                  </button>
                  <button className="cmd" onClick={() => downloadBlob(new Blob([markdown], { type: "text/plain" }), `${fileBase("Resume")}.txt`)}>
                    .txt
                  </button>
                  <button className="cmd add" onClick={() => printFrame(mdFrame, "resume_md")}>
                    Save as PDF ↧
                  </button>
                  <BusyButton k="md-pdf" busy={busy} elapsed={elapsed} disabled={!inputs.texEngine} title={noEngineTitle} onClick={() => compileMarkdown(false)}>
                    typeset PDF
                  </BusyButton>
                  <BusyButton k="md-save" busy={busy} elapsed={elapsed} disabled={!inputs.texEngine} title={noEngineTitle} onClick={() => compileMarkdown(true)}>
                    use for autofill
                  </BusyButton>
                  <button className="copy" onClick={() => copy(markdown)}>
                    copy
                  </button>
                </div>
                <DocSplit
                  value={markdown}
                  onChange={(t) => edit("resume_md", t)}
                  onBlur={() => void saveEdit("resume_md")}
                  dirty={isDirty("resume_md")}
                  edited={!!drafts["resume_md"]?.edited}
                  preview={<iframe ref={mdFrame} className="page-frame" title="Résumé preview" srcDoc={mdHtml} sandbox="allow-same-origin allow-modals" />}
                />
              </>
            )}
            {latexLog && fmt === "markdown" && <CompilerLog log={latexLog} />}
          </Pane>
        )}

        {fmt === "latex" && (
          <Pane
            genKey="resume_latex"
            draft={drafts["resume_latex"]}
            empty={!latex}
            onGen={() => generate("resume_latex", !!drafts["resume_latex"])}
            busy={busy}
            elapsed={elapsed}
            cancel={cancel}
            msg={msgs["resume_latex"]}
            hint={
              inputs.hasLatex
                ? "Rewrites the content of your LaTeX template; its preamble (styling, packages, macros) is kept byte-for-byte."
                : "No LaTeX template imported, so this uses the built-in one. Import your .tex in Settings to keep your own styling."
            }
          >
            {latex && (
              <>
                <div className="latex-actions">
                  <button className="cmd" onClick={() => downloadBlob(new Blob([latex], { type: "application/x-tex" }), `${fileBase("Resume")}.tex`)}>
                    download .tex
                  </button>
                  <BusyButton k="pdf-preview" busy={busy} elapsed={elapsed} disabled={!inputs.texEngine} title={noEngineTitle} onClick={() => compileLatex("preview")} add>
                    compile &amp; preview
                  </BusyButton>
                  <BusyButton k="pdf-download" busy={busy} elapsed={elapsed} disabled={!inputs.texEngine} title={noEngineTitle} onClick={downloadLatexPdf}>
                    download PDF
                  </BusyButton>
                  <BusyButton k="pdf-save" busy={busy} elapsed={elapsed} disabled={!inputs.texEngine} title={noEngineTitle} onClick={() => compileLatex("save")}>
                    use for autofill
                  </BusyButton>
                  {busy?.key.startsWith("pdf-") && (
                    <button className="cmd danger" onClick={cancel}>
                      cancel
                    </button>
                  )}
                </div>
                <DocSplit
                  value={latex}
                  onChange={(t) => edit("resume_latex", t)}
                  onBlur={() => void saveEdit("resume_latex")}
                  dirty={isDirty("resume_latex")}
                  edited={!!drafts["resume_latex"]?.edited}
                  preview={
                    pdf ? (
                      <>
                        {pdf.forText !== latex && <div className="page-note">The preview is from an earlier version — compile again to update it.</div>}
                        <iframe className="page-frame" title="PDF preview" src={pdf.url} />
                      </>
                    ) : (
                      <div className="page-empty">
                        {inputs.texEngine ? (
                          <>Press “compile &amp; preview” to see the PDF here ({inputs.texEngine}).</>
                        ) : (
                          <>
                            No LaTeX engine on this machine, so there&apos;s no PDF preview. Install{" "}
                            <a href="https://tectonic-typesetting.github.io/" target="_blank" rel="noreferrer">
                              tectonic
                            </a>{" "}
                            (one binary — put it on PATH and restart the web app; its first compile downloads packages and takes a
                            few minutes), or download the .tex and open it in Overleaf.
                          </>
                        )}
                      </div>
                    )
                  }
                />
              </>
            )}
            {latexLog && fmt === "latex" && <CompilerLog log={latexLog} />}
          </Pane>
        )}

        {fmt === "bullets" && (
          <Pane
            genKey="resume"
            draft={drafts["resume"]}
            empty={!drafts["resume"]?.variants}
            onGen={() => generate("resume", !!drafts["resume"])}
            busy={busy}
            elapsed={elapsed}
            cancel={cancel}
            msg={msgs["resume"]}
            hint="Three framings of your strongest bullets for this role — to paste into a form or your own résumé."
          >
            {drafts["resume"]?.variants && <ResumeBlock variants={drafts["resume"]!.variants!} variant={variant} onVariant={setVariant} />}
          </Pane>
        )}
      </section>

      {/* ── cover letter (optional) ── */}
      <section className="card-block tailor-block">
        <div className="tailor-block-head">
          <div>
            <h2>
              Cover letter <span className="hint">— optional</span>
            </h2>
            <span className="hint">grounded in your material; company facts only from this JD</span>
          </div>
        </div>
        <label className="note-field">
          <span className="hint">Why this company? Your own words, optional — without them the letter won&apos;t claim a reason.</span>
          <textarea
            className="answer-text"
            rows={2}
            value={note}
            placeholder="e.g. I use their API at work and want to build the platform side of it."
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Pane
          genKey="cover_letter"
          draft={drafts["cover_letter"]}
          empty={!letter}
          onGen={() => generate("cover_letter", !!drafts["cover_letter"])}
          busy={busy}
          elapsed={elapsed}
          cancel={cancel}
          msg={msgs["cover_letter"]}
          disabledReason={inputs.offline ? "Cover letters need a generation model — set one in Settings." : undefined}
        >
          {letter && (
            <>
              <div className="latex-actions">
                <button className="cmd" onClick={() => downloadBlob(new Blob([letter], { type: "text/plain" }), `${fileBase("Cover_Letter")}.txt`)}>
                  download .txt
                </button>
                <button className="cmd" onClick={() => downloadBlob(new Blob([letter], { type: "text/markdown" }), `${fileBase("Cover_Letter")}.md`)}>
                  .md
                </button>
                <button className="cmd add" onClick={() => printFrame(letterFrame, "cover_letter")}>
                  Save as PDF ↧
                </button>
                <button className="copy" onClick={() => copy(letter)}>
                  copy
                </button>
                <span className="hint">{wordCount(letter)} words</span>
              </div>
              <DocSplit
                value={letter}
                onChange={(t) => edit("cover_letter", t)}
                onBlur={() => void saveEdit("cover_letter")}
                dirty={isDirty("cover_letter")}
                edited={!!drafts["cover_letter"]?.edited}
                prose
                preview={<iframe ref={letterFrame} className="page-frame short" title="Cover letter preview" srcDoc={letterHtml} sandbox="allow-same-origin allow-modals" />}
              />
            </>
          )}
        </Pane>
      </section>

      {/* ── application answers ── */}
      {ANSWER_SECTIONS.map(({ kind, title, blurb }) => {
        const d = drafts[kind];
        return (
          <section className="card-block tailor-block" key={kind}>
            <div className="tailor-block-head">
              <div>
                <h2>{title}</h2>
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
                  <button className="cmd" disabled={inputs.offline} title={inputs.offline ? "Needs a generation model — set one in Settings." : undefined} onClick={() => generate(kind, !!d)}>
                    {d ? "↻ regenerate" : "generate"}
                  </button>
                )}
              </div>
            </div>
            {d?.stale && <div className="tailor-warn">Your profile, evidence, model or this posting changed since this was written — regenerate to pick that up.</div>}
            {d?.text && (
              <div className="answer-block">
                <textarea className="answer-text" value={textOf(kind)} onChange={(e) => edit(kind, e.target.value)} onBlur={() => void saveEdit(kind)} rows={6} />
                <div className="answer-foot">
                  <span className="hint">
                    {wordCount(textOf(kind))} words · {d.edited || isDirty(kind) ? "edited" : "editable"} before you copy
                  </span>
                  <button className="copy" onClick={() => copy(textOf(kind))}>
                    copy
                  </button>
                </div>
              </div>
            )}
            {!d && busy?.key !== kind && <div className="gen-empty">{inputs.offline ? "Needs a generation model." : "Not generated yet."}</div>}
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
          “Save” attaches your edited answers, cover letter and chosen bullet variant to this role’s application. “Fill” hands it to your
          local agent, which pre-fills the form in your own browser and <strong>stops at review</strong> — it never submits. For the
          résumé attachment, use <strong>use for autofill</strong> under Markdown or LaTeX (else your base résumé is attached).
        </p>
        <MsgLine msg={msgs["app"]} />
      </section>
    </div>
  );
}

/** What tailoring will ground on, with the gaps that make a draft worse called out. */
function InputsStrip({ inputs }: { inputs: TailorInputs }) {
  const warnings: ReactNode[] = [];
  if (inputs.offline)
    warnings.push(
      <>
        No generation model is set, so nothing here is tailored: résumés are your own, reformatted, and answers and cover letters are
        off. <a href="/settings">Set a model in Settings</a>.
      </>,
    );
  if (!inputs.resumeChars && !inputs.hasLatex) warnings.push(<>No base résumé yet — upload one in <a href="/settings">Settings</a>; tailoring rewrites it.</>);
  if (inputs.sampleEvidence)
    warnings.push(
      <>
        {inputs.sampleEvidence === inputs.evidence ? "All" : inputs.sampleEvidence} of your {inputs.evidence} Evidence Bank entries{" "}
        {inputs.sampleEvidence === 1 ? "is a built-in sample" : "are the built-in samples"} — replace or remove them in{" "}
        <a href="/settings">Settings</a>, or they can end up in your résumé.
      </>,
    );
  if (!inputs.hasEmail) warnings.push(<>Your contact email is empty — the résumé header falls back to your résumé text, and autofill needs it (Settings › Contact).</>);
  const chip = (ok: boolean, label: string) => (
    <span className="in-chip" data-ok={ok}>
      {ok ? "✓" : "–"} {label}
    </span>
  );
  return (
    <div className="inputs-strip">
      <div className="in-chips">
        <span className="hint">grounded on</span>
        {chip(inputs.resumeChars > 0, inputs.resumeChars ? `résumé · ${inputs.resumeChars.toLocaleString()} chars` : "no résumé")}
        {chip(inputs.hasLatex, inputs.hasLatex ? "LaTeX template" : "no LaTeX template")}
        {chip(inputs.aboutChars > 0, inputs.aboutChars ? "about you" : "no about")}
        {chip(inputs.skills > 0, `${inputs.skills} skills`)}
        {chip(inputs.evidence > inputs.sampleEvidence, `${inputs.evidence} evidence${inputs.sampleEvidence ? ` (${inputs.sampleEvidence} sample)` : ""}`)}
      </div>
      {warnings.length > 0 && (
        <ul className="in-warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A generate/regenerate pane with progress, cancel, draft status, and a message line. */
function Pane({
  genKey,
  draft,
  empty,
  onGen,
  busy,
  elapsed,
  cancel,
  msg,
  hint,
  disabledReason,
  children,
}: {
  genKey: string;
  draft?: Draft;
  empty: boolean;
  onGen: () => void;
  busy: Busy;
  elapsed: number;
  cancel: () => void;
  msg?: Msg;
  hint?: string;
  disabledReason?: string;
  children?: ReactNode;
}) {
  const mine = busy?.key === genKey;
  return (
    <div className="pane">
      <div className="pane-head">
        {hint && <span className="hint">{hint}</span>}
        <div className="pane-btns">
          {draft && !mine && (
            <span className="gen-meta" style={{ marginRight: 8 }} suppressHydrationWarning>
              {draft.source === "builtin" ? "built-in" : draft.model} · {timeAgo(draft.createdAt)}
            </span>
          )}
          {mine ? (
            <span className="gen-meta">
              {busy!.label} {elapsed}s{" "}
              <button className="cmd" onClick={cancel}>
                cancel
              </button>
            </span>
          ) : (
            <button className="cmd" onClick={onGen} disabled={!!disabledReason} title={disabledReason}>
              {empty ? "generate" : "↻ regenerate"}
            </button>
          )}
        </div>
      </div>
      {draft?.source === "builtin" && !mine && (
        <div className="tailor-warn">
          Not tailored — no generation model is set, so this is {draft.kind === "resume" ? "your own bullets, ranked by overlap with this JD" : "your own résumé, reformatted"}.
          Set a model in Settings › Generation model, then regenerate.
        </div>
      )}
      {draft?.stale && draft.source !== "builtin" && !mine && (
        <div className="tailor-warn">Your profile, evidence, model or this posting changed since this draft — regenerate to pick that up.</div>
      )}
      {children}
      {empty && !mine && <div className="gen-empty">{disabledReason ?? "Not generated yet."}</div>}
      <MsgLine msg={msg} />
    </div>
  );
}

/** Source editor beside its rendered preview. */
function DocSplit({
  value,
  onChange,
  onBlur,
  dirty,
  edited,
  preview,
  prose,
}: {
  value: string;
  onChange: (t: string) => void;
  onBlur: () => void;
  dirty: boolean;
  edited: boolean;
  preview: ReactNode;
  prose?: boolean;
}) {
  return (
    <div className="doc-split">
      <div className="doc-col">
        <div className="doc-label">
          {prose ? "text" : "source"}
          {dirty ? " · unsaved edit" : edited ? " · edited" : ""}
        </div>
        <textarea className={`doc-src${prose ? " prose" : ""}`} value={value} spellCheck={!!prose} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
      </div>
      <div className="doc-col">
        <div className="doc-label">preview</div>
        {preview}
      </div>
    </div>
  );
}

function BusyButton({
  k,
  busy,
  elapsed,
  onClick,
  disabled,
  title,
  add,
  children,
}: {
  k: string;
  busy: Busy;
  elapsed: number;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  add?: boolean;
  children: ReactNode;
}) {
  const mine = busy?.key === k;
  return (
    <button className={`cmd${add ? " add" : ""}`} disabled={disabled || mine} title={title} onClick={onClick}>
      {mine ? `${busy!.label} ${elapsed}s` : children}
    </button>
  );
}

function CompilerLog({ log }: { log: string }) {
  return (
    <details className="src-preview" style={{ marginTop: 8 }}>
      <summary>compiler log</summary>
      <pre>{log}</pre>
    </details>
  );
}

function MsgLine({ msg }: { msg?: Msg }) {
  if (!msg) return null;
  return (
    <div className={msg.tone === "ok" ? "tailor-app-msg" : msg.tone === "warn" ? "tailor-warn" : "tailor-err"}>
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

function wordCount(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
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
