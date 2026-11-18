"use client";

import { useEffect, useState } from "react";
import type { JobDetail } from "@jobflow/service";
import { ageText, experienceText, locationText, payText, roleText, sourceText, STATUS_LABEL } from "@/lib/cardText";
import { LOCAL_AGENT_GUIDE } from "@/lib/docs";
import { Badge, Banner, Button, Icon, btn } from "./ui";

const TIER3 = new Set(["naukri", "ambitionbox", "glassdoor", "linkedin"]);

const STATUSES = ["saved", "drafting", "ready", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "ghosted"];
const BEFORE_APPLY = new Set(["saved", "drafting", "ready"]);

const GAP_FIX: Record<string, { label: string; fix: string; href: string }> = {
  name: { label: "Your name", fix: "Add it in your profile", href: "/profile#contact" },
  email: { label: "Your email", fix: "Add it in your profile", href: "/profile#contact" },
  resume: { label: "A résumé file to attach", fix: "Upload your résumé, or make a tailored PDF", href: "/profile#resume" },
  resumeFormat: { label: "A PDF or Word résumé", fix: "Forms want PDF/Word — make a tailored PDF", href: "" },
  applyUrl: { label: "An application link", fix: "This listing has none — apply where it was posted", href: "" },
};

const FIELD: Record<string, string> = {
  firstName: "first name", lastName: "last name", fullName: "full name", email: "email", phone: "phone",
  linkedin: "LinkedIn", github: "GitHub", portfolio: "portfolio", resume: "résumé file", coverLetter: "cover letter",
};

const DRAFT_KIND: Record<string, string> = {
  resume: "Résumé bullets", resume_md: "Résumé (Markdown)", resume_latex: "Résumé (LaTeX)", cover_letter: "Cover letter",
  why_company: "Why this company", interesting_problem: "A problem you solved", about_blurb: "About you", answer: "Answer",
};

/**
 * One job: decide (fit, description) and act (save, tailor, apply, track). The apply panel
 * is a checklist with a fix for each gap, then the three honest options: open the form,
 * pre-fill it on this computer (which always stops for you), or record that you applied.
 */
export function JobView({ initial }: { initial: JobDetail }) {
  const [job, setJob] = useState(initial);
  const [bookmarked, setBookmarked] = useState(initial.card.bookmarked);
  const [hidden, setHidden] = useState(initial.card.archived);
  const [notice, setNotice] = useState<string | null>(null);
  const [agentOnline, setAgentOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nextAction, setNextAction] = useState(initial.application?.nextAction ?? "");
  const [nextDate, setNextDate] = useState(initial.application?.nextActionAt ? String(initial.application.nextActionAt).slice(0, 10) : "");
  const c = job.card;
  const status = job.application?.status ?? null;
  const pay = payText(c);
  const exp = experienceText(c.experience);
  const gaps = job.apply.missing;
  const geoBad = c.location.remoteGeo === "us_only" || c.location.remoteGeo === "eu_only";
  const fillCommand = `pnpm jobflow apply ${c.id} --fill`;

  useEffect(() => {
    fetch("/api/jobs", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAgentOnline(!!d?.agentOnline))
      .catch(() => setAgentOnline(false));
  }, []);

  const reload = async () => {
    const r = await fetch(`/api/postings/${c.id}`, { cache: "no-store" });
    if (r.ok) setJob(await r.json());
  };
  const send = (url: string, body: unknown, method = "POST") =>
    fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 6000);
  };

  async function setStatus(next: string, msg?: string) {
    if (!job.application) await send("/api/applications", { postingId: c.id, status: next });
    else await send("/api/applications", { postingId: c.id, status: next }, "PATCH");
    await reload();
    flash(msg ?? `Status: ${STATUS_LABEL[next] ?? next}.`);
  }

  async function toggleSave() {
    const next = !bookmarked;
    setBookmarked(next);
    await send("/api/postings/bookmark", { postingId: c.id }, next ? "POST" : "DELETE");
    if (next && !job.application) {
      await send("/api/applications", { postingId: c.id, status: "saved" });
      await reload();
      flash("Saved — it's in your Applications as “Saved”.");
    } else flash(next ? "Saved." : "Removed from Saved.");
  }

  async function toggleHide() {
    const next = !hidden;
    setHidden(next);
    await send("/api/postings/archive", { postingId: c.id }, next ? "POST" : "DELETE");
    flash(next ? "Hidden from your Jobs list. Find it under Jobs → Hidden." : "Back in your Jobs list.");
  }

  async function saveFollowUp() {
    await send("/api/applications", { postingId: c.id, nextAction: nextAction || null, nextActionAt: nextDate ? new Date(nextDate).toISOString() : null }, "PATCH");
    await reload();
    flash(nextDate ? `Follow-up set for ${nextDate}.` : "Next step saved.");
  }

  async function sendToAgent() {
    const r = await send("/api/jobs", { type: "form_fill", payload: { postingId: c.id } });
    flash(r.ok ? "Sent to your local agent — the form opens in your browser, filled and waiting for your review." : "Couldn't reach the local agent queue.");
    if (r.ok && (!status || status === "saved")) await setStatus("ready", "Sent to your local agent. Marked “Ready to apply”.");
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(fillCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="ux-job">
      <div aria-live="polite">
        {notice && (
          <Banner tone="good" className="notice">
            {notice}
          </Banner>
        )}
      </div>

      {/* ── summary + primary actions ── */}
      <section className="card-block ux-job-summary">
        <div className="ux-job-facts">
          {job.scored ? (
            <div className="match__score ux-score" data-band={c.score >= 78 ? "hi" : c.score >= 60 ? "mid" : "lo"} role="img" aria-label={`Match score ${c.score} of 100`}>
              <span className="score-num" aria-hidden="true">
                {c.score}
              </span>
              <span className="score-meter" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
              </span>
            </div>
          ) : (
            <a className="ux-score ux-score--none" href="/onboarding">
              Not scored yet — add your résumé
            </a>
          )}
          <div className="match__tags">
            <Badge tone={geoBad ? "warn" : "neutral"} title={geoBad ? "“Remote”, but restricted to one region — check you can work from there" : undefined}>
              {geoBad && <Icon name="warn" size={12} />}
              {locationText(c)}
            </Badge>
            {c.location.confidence < 0.5 && (
              <Badge tone="warn" title="We couldn't read the location confidently — check it before applying">
                check location
              </Badge>
            )}
            {c.location.places.length > 1 && (
              <Badge title="Every place the posting names">{c.location.places.join(" · ")}</Badge>
            )}
            {c.agency && (
              <Badge tone="warn" title="A recruiter posted this for a client, not the employer itself — the client may be unnamed and replies are usually slower">
                staffing agency
              </Badge>
            )}
            {pay && c.comp && (
              <Badge estimate={pay.estimate} className="tag comp" data-estimate={pay.estimate || undefined} title={pay.title}>
                {c.comp.label}{" "}
                <span className="conf">· {pay.estimate ? `${Math.round((c.comp.confidenceScore ?? 0) * 100)}%` : c.comp.confidence}</span>
              </Badge>
            )}
            {exp && (
              <Badge
                tone={job.scored && c.experience.fit === "far" ? "bad" : job.scored && c.experience.fit === "stretch" ? "warn" : "neutral"}
                title="Years of experience the posting asks for"
              >
                asks {exp}
              </Badge>
            )}
            <Badge tone={c.ageDays <= 3 ? "good" : "neutral"}>
              <span className="badge__dot" aria-hidden="true" />
              posted {ageText(c.ageDays)}
            </Badge>
            <Badge tone={c.atsDirect ? "info" : "neutral"}>{sourceText(c)}</Badge>
            {TIER3.has(c.source) && <Badge tone="warn">found by your local agent</Badge>}
            {c.trust < 0.4 && (
              <Badge tone="warn" title="This listing has signs of being stale, re-posted, or from an agency">
                low trust {Math.round(c.trust * 100)}%
              </Badge>
            )}
            {c.services && <Badge title="IT-services / outsourcing employer">IT services</Badge>}
            <Badge>{roleText(c.archetype)}</Badge>
          </div>
        </div>
        <div className="ux-actions">
          <Button icon="bookmark" aria-pressed={bookmarked} onClick={toggleSave} title="Save it for later — it shows up in Applications as Saved">
            {bookmarked ? "Saved" : "Save"}
          </Button>
          <a className={btn("secondary")} href={`/tailor/${c.id}`} title="Draft a résumé, cover letter or answers for this job — from your own material">
            <Icon name="pencil" />
            Tailor
          </a>
          <a className={btn("primary")} href="#apply">
            Apply ↓
          </a>
          <span className="ux-status">
            {status ? (
              <label>
                Status{" "}
                <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="hint">Not tracked yet</span>
            )}
          </span>
        </div>
        {c.applied && !status && <p className="hint">You already have an application for this role at {c.company} (another listing of it).</p>}
      </section>

      {/* ── fit ── */}
      <section className="card-block">
        <h2>How you fit</h2>
        {!job.scored ? (
          <p className="empty-note">
            JobFlow only scores a job once it knows your background. <a href="/onboarding">Add your résumé</a> and this page will show
            why it fits, the likely gap, and anything to check before applying.
          </p>
        ) : (
          <dl className="ux-kv">
            {job.fit?.whyFit && job.fit.whyFit !== c.stackNote && (
              <>
                <dt>Why it fits</dt>
                <dd>{job.fit.whyFit}</dd>
              </>
            )}
            {c.stackNote && (
              <>
                <dt>Stack</dt>
                <dd>{c.stackNote}</dd>
              </>
            )}
            {c.levelNote && (
              <>
                <dt>Level</dt>
                <dd>{c.levelNote}</dd>
              </>
            )}
            {job.fit?.gap && (
              <>
                <dt>Likely gap</dt>
                <dd>{job.fit.gap}</dd>
              </>
            )}
            {exp && c.experience.fit && c.experience.fit !== "ok" && (
              <>
                <dt>Experience</dt>
                <dd>
                  Asks {exp} — {c.experience.fit === "stretch" ? "a stretch for you, but often negotiable" : "well above yours; usually screened on"}.
                </dd>
              </>
            )}
            {c.redFlags.length > 0 && (
              <>
                <dt>Check before applying</dt>
                <dd>
                  <ul className="ux-list">
                    {c.redFlags.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {!job.fit && !c.stackNote && !c.levelNote && !c.redFlags.length && (
              <>
                <dt>Notes</dt>
                <dd>No concerns found. Read the description below to confirm.</dd>
              </>
            )}
          </dl>
        )}
        {pay?.estimate && <p className="hint">Pay: {pay.title}</p>}
      </section>

      {/* ── apply ── */}
      <section className="card-block" id="apply">
        <h2>Apply</h2>
        {status && !BEFORE_APPLY.has(status) ? (
          <>
            <p>
              <b>{STATUS_LABEL[status]}</b>
              {job.application?.submittedAt ? ` · applied ${new Date(job.application.submittedAt as unknown as string).toLocaleDateString()}` : ""}.
              Keep the next step here so it shows up in Applications when it's due.
            </p>
            <FollowUp nextAction={nextAction} setNextAction={setNextAction} nextDate={nextDate} setNextDate={setNextDate} onSave={saveFollowUp} />
          </>
        ) : (
          <>
            <ol className="ux-checklist">
              {(["name", "email"] as const).map((k) => (
                <li key={k} data-done={!gaps.includes(k)}>
                  {GAP_FIX[k]!.label}
                  {gaps.includes(k) && (
                    <>
                      {" "}— <a href={GAP_FIX[k]!.href}>{GAP_FIX[k]!.fix}</a>
                    </>
                  )}
                </li>
              ))}
              <li data-done={!gaps.includes("resume") && !gaps.includes("resumeFormat")}>
                {job.apply.resume.exists && job.apply.resume.fileName ? (
                  <>
                    Résumé: <code>{job.apply.resume.fileName}</code> ({job.apply.resume.source === "tailored" ? "tailored for this job" : "your base résumé"})
                    {gaps.includes("resumeFormat") && (
                      <>
                        {" "}— forms want PDF or Word: <a href={`/tailor/${c.id}`}>make a tailored PDF</a>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {GAP_FIX.resume!.label} — <a href="/profile#resume">upload your résumé</a> or <a href={`/tailor/${c.id}`}>make a tailored PDF</a>
                  </>
                )}
              </li>
              <li data-done={job.apply.coverLetter} data-optional="true">
                Cover letter (optional) — {job.apply.coverLetter ? "saved for this job" : <a href={`/tailor/${c.id}`}>write one from your material</a>}
              </li>
            </ol>
            {job.apply.willFill.length > 0 && (
              <p className="hint">
                The pre-filler would type: {job.apply.willFill.map((f) => FIELD[f] ?? f).join(", ")}
                {job.apply.answers ? ` and ${job.apply.answers} saved answer${job.apply.answers === 1 ? "" : "s"}` : ""}.
                {job.apply.leftForYou.length > 0 && <> Left for you: {job.apply.leftForYou.map((f) => FIELD[f] ?? f).join(", ")}.</>}
              </p>
            )}

            <div className="ux-apply-options">
              <div className="ux-option">
                <b>1. Open the application form</b>
                <p className="hint">Apply in your browser yourself.</p>
                {job.apply.applyUrl ? (
                  <a className={btn("primary", "sm")} href={job.apply.applyUrl} target="_blank" rel="noreferrer">
                    Open form ↗<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="hint">No application link on this listing</span>
                )}
              </div>
              <div className="ux-option">
                <b>2. Pre-fill it on this computer</b>
                <p className="hint">
                  JobFlow opens the form in a local browser, types only what you stored, attaches your résumé — then stops. You check
                  every field and press submit yourself.
                </p>
                {agentOnline ? (
                  <Button size="sm" onClick={sendToAgent} disabled={!job.apply.applyUrl || gaps.includes("email")}>
                    Pre-fill with the local agent
                  </Button>
                ) : (
                  <>
                    <p className="hint">Run this in your JobFlow folder:</p>
                    <div className="ux-copy">
                      <code>{fillCommand}</code>
                      <Button size="sm" variant="ghost" onClick={copyCommand} aria-label="Copy the pre-fill command">
                        {copied ? "copied" : "copy"}
                      </Button>
                      <span className="sr-only" aria-live="polite">
                        {copied ? "Copied to the clipboard" : ""}
                      </span>
                    </div>
                    <p className="hint">
                      If you opened this page with <code>jobflow serve</code>, stop it first — the local database takes one writer at a time.
                      Want a button here instead? Run the local agent; it needs a database it can share with this app (Postgres via{" "}
                      <code>DATABASE_URL</code>, e.g. the Docker stack's on <code>localhost:5433</code>) —{" "}
                      <a href={LOCAL_AGENT_GUIDE} target="_blank" rel="noreferrer">
                        local agent guide
                      </a>
                      .
                    </p>
                  </>
                )}
              </div>
              <div className="ux-option">
                <b>3. Done? Record it</b>
                <p className="hint">Only you know when it's submitted — JobFlow never submits for you.</p>
                <Button size="sm" onClick={() => setStatus("applied", "Marked as applied. Add a follow-up below so you don't lose track.")}>
                  I submitted it — mark applied
                </Button>
              </div>
            </div>
            {status !== "ready" && !gaps.filter((g) => g !== "applyUrl").length && job.apply.applyUrl && (
              <p className="hint">
                Everything's in place.{" "}
                <Button size="sm" variant="ghost" onClick={() => setStatus("ready")}>
                  Mark “Ready to apply”
                </Button>
              </p>
            )}
          </>
        )}
      </section>

      {/* ── drafts ── */}
      <section className="card-block">
        <h2>Your drafts for this job</h2>
        {job.drafts.length === 0 ? (
          <p className="empty-note">
            None yet. <a href={`/tailor/${c.id}`}>Tailor</a> drafts a résumé, cover letter or answers using only your résumé, your Evidence
            Bank and your skills — rephrased for this job, never extended.
          </p>
        ) : (
          <ul className="ux-list">
            {job.drafts.map((d) => (
              <li key={`${d.kind}-${d.createdAt}`}>
                {DRAFT_KIND[d.kind] ?? d.kind} —{" "}
                {d.source === "builtin" ? "from your résumé (template, not model-written)" : `written by ${d.model}`}
                {d.stale && <span className="hint"> · out of date (your profile or the job changed)</span>}
              </li>
            ))}
            <li>
              <a href={`/tailor/${c.id}`}>Open Tailor →</a>
            </li>
          </ul>
        )}
      </section>

      {/* ── description ── */}
      <section className="card-block">
        <h2>Job description</h2>
        {(job.requirements.must.length > 0 || c.skills.length > 0) && (
          <div className="match__skills">
            {(job.requirements.must.length ? job.requirements.must : c.skills).map((s) => (
              <span className="match__skill" key={s} title={job.requirements.must.includes(s) ? "listed as a must-have" : undefined}>
                {s.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
        {job.description ? <div className="ux-jd">{job.description}</div> : <p className="empty-note">This listing has no description. Open the original to read it.</p>}
        {c.applyUrl && (
          <p className="hint">
            <a href={c.applyUrl} target="_blank" rel="noreferrer">
              Original listing ↗
            </a>
          </p>
        )}
      </section>

      <section className="card-block">
        <h2>Not for you?</h2>
        <div className="ux-actions">
          <Button icon={hidden ? "unarchive" : "archive"} onClick={toggleHide}>
            {hidden ? "Show in Jobs again" : "Hide from my Jobs"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function FollowUp({
  nextAction,
  setNextAction,
  nextDate,
  setNextDate,
  onSave,
}: {
  nextAction: string;
  setNextAction: (v: string) => void;
  nextDate: string;
  setNextDate: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="field-row">
      <label>
        next step
        <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. follow up with the recruiter" />
      </label>
      <label>
        by
        <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
      </label>
      <Button onClick={onSave}>Save next step</Button>
    </div>
  );
}
