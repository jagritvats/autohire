"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SYNC_PHASE_LABEL, type SyncProgress } from "@jobflow/core";
import { cancelSync, relTime, startSync, untilTime, useSyncStatus, TRIGGER_LABEL } from "@/lib/syncClient";
import { Banner, Button, ButtonLink, Icon } from "./ui";
import { PhaseStepper, ProgressBar, ProgressRing, RunBody, RunCounts, RunErrors, runFraction, runHeadline } from "./SyncDetails";

/**
 * The header's sync indicator. Idle: "Synced 12 min ago · next in 48 min". Running: a
 * progress ring + phase + "38/232". Clicking opens the sync panel (a dialog): the phase
 * stepper, bars, in-flight boards, errors, time left, cancel — or, idle, the last run and
 * "Sync now". Phase changes and the finish are announced politely; counts are not (too chatty).
 */
export function SyncIndicator() {
  const { status } = useSyncStatus();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [, setNow] = useState(0);

  // relative times ("12 min ago") move on their own
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = status?.current ?? null;
  const announce = useAnnouncement(status);

  let label: React.ReactNode;
  let title: string;
  if (!status) {
    label = <span className="sync-ind__text">Sync</span>;
    title = "Sync status";
  } else if (run) {
    const f = runFraction(run);
    label = (
      <>
        <ProgressRing value={f} />
        <IndicatorText run={run} />
      </>
    );
    title = `Syncing — ${Math.round(f * 100)}% · open the sync panel`;
  } else {
    const next = untilTime(status.nextSyncAt);
    label = (
      <>
        <Icon name={status.last?.status === "failed" || (status.last?.errors.length ?? 0) > 0 ? "warn" : "refresh"} size={14} />
        <span className="sync-ind__text">{status.lastSyncAt ? `Synced ${relTime(status.lastSyncAt)}` : "Never synced"}</span>
        {next && <span className="sync-ind__next">· next {next}</span>}
      </>
    );
    title = status.lastSyncAt ? `Last sync ${new Date(status.lastSyncAt).toLocaleString()}${next ? ` · next ${next}` : ""}` : "No sync yet";
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="sync-ind"
        data-running={run ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="sync-panel"
        title={title}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      {/* portalled to <body>: the sticky header's backdrop-filter would otherwise be the
          containing block of the fixed sheet and clip it to the header's height */}
      {open &&
        createPortal(
          <SyncPanelDialog
            onClose={() => {
              setOpen(false);
              button.current?.focus();
            }}
          />,
          document.body,
        )}
    </>
  );
}

/** "Check job boards · 38/232"; on a phone just "38/232" beside the ring */
function IndicatorText({ run }: { run: SyncProgress }) {
  const head = runHeadline(run);
  const m = / · (\d+\/\d+)$/.exec(head);
  if (!m) return <span className="sync-ind__text">{head}</span>;
  return (
    <span className="sync-ind__text">
      <span className="sync-ind__phase">{head.slice(0, m.index)} · </span>
      <span className="num">{m[1]}</span>
    </span>
  );
}

/** a polite one-liner when a phase changes or a run ends — never on every count */
function useAnnouncement(status: ReturnType<typeof useSyncStatus>["status"]): string {
  const [msg, setMsg] = useState("");
  const key = useRef<string>("");
  useEffect(() => {
    if (!status) return;
    const run = status.current;
    const k = run ? `${run.runId}:${run.phase ?? "start"}:${run.cancelRequested}` : status.last ? `done:${status.last.runId}` : "";
    if (!k || k === key.current) return;
    const first = key.current === "";
    key.current = k;
    if (first) return; // don't announce what was already on screen
    if (run) setMsg(run.cancelRequested ? "Stopping the sync." : run.phase ? `Sync: ${SYNC_PHASE_LABEL[run.phase]}.` : "Sync started.");
    else if (status.last) {
      const you = status.you?.ranked ? ` ${status.you.newMatches} new match${status.you.newMatches === 1 ? "" : "es"} for you.` : "";
      setMsg(`Sync finished. ${status.last.message ?? ""}${you}`);
    }
  }, [status]);
  return msg;
}

function SyncPanelDialog({ onClose }: { onClose: () => void }) {
  const { status, transport, error } = useSyncStatus();
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = status?.current ?? null;
  const last = status?.last ?? null;

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // keep Tab inside the dialog
      if (e.key === "Tab" && panel.current) {
        const items = panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])");
        const first = items[0];
        const lastItem = items[items.length - 1];
        if (!first || !lastItem) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("scroll-locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("scroll-locked");
    };
  }, [onClose]);

  async function syncNow() {
    setBusy(true);
    setMsg(await startSync());
    setBusy(false);
  }
  async function cancel() {
    setBusy(true);
    setMsg(await cancelSync());
    setBusy(false);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div id="sync-panel" ref={panel} className="sync-drawer" role="dialog" aria-modal="true" aria-labelledby="sync-panel-title" tabIndex={-1}>
        <header className="sync-drawer__head">
          <h2 id="sync-panel-title" className="sync-drawer__title">
            {run ? "Syncing" : "Sync"}
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close the sync panel">
            <Icon name="x" />
          </button>
        </header>

        <div className="sync-drawer__body">
          {!status && <p className="hint">{error ?? "Loading…"}</p>}

          {run && (
            <section aria-label="Current sync">
              <p className="sync-drawer__lead">
                <b>{runHeadline(run)}</b>
                <span className="hint"> · {TRIGGER_LABEL[run.trigger]}</span>
              </p>
              <ProgressBar value={runFraction(run)} label="Sync progress" className="sync-bar--lg" />
              <RunBody run={run} />
              <RunCounts run={run} />
              <PhaseStepper run={run} />
              <RunErrors run={run} />
              {status?.canSync && (
                <p className="hint sync-drawer__fine">
                  Cancel stops starting new boards. Jobs already fetched are kept and ranked; nothing is marked closed from a cut-short sync.
                </p>
              )}
            </section>
          )}

          {!run && status && (
            <section aria-label="Last sync">
              {last ? (
                <>
                  <p className="sync-drawer__lead">
                    <b>{last.status === "cancelled" ? "Last sync was cancelled" : last.status === "failed" ? "Last sync stopped with an error" : "Last sync finished"}</b>
                    <span className="hint"> · {relTime(last.finishedAt)} · {TRIGGER_LABEL[last.trigger]}</span>
                  </p>
                  {status.you?.ranked && (
                    <Banner tone={status.you.newMatches ? "good" : "info"} title={`${status.you.newMatches} new match${status.you.newMatches === 1 ? "" : "es"} for you`}>
                      New jobs scoring {status.you.threshold}+ against your profile{status.you.strongMatches ? `, ${status.you.strongMatches} of them strong` : ""}.{" "}
                      {status.you.newMatches > 0 && <a href="/">Show them on Jobs →</a>}
                    </Banner>
                  )}
                  <p className="sync-drawer__msg">{last.message}</p>
                  <RunCounts run={last} />
                  <PhaseStepper run={last} />
                  <RunErrors run={last} />
                </>
              ) : (
                <p className="hint">No sync has run yet. A sync fetches jobs from your presets, your own sources and your saved searches, then ranks them for you.</p>
              )}
              <p className="hint sync-drawer__next">
                {status.nextSyncAt ? `Next scheduled sync ${untilTime(status.nextSyncAt)}.` : "No sync is scheduled in this app — sync when you like, or run `jobflow sync`."}
              </p>
            </section>
          )}

          {msg && (
            <Banner tone="bad" live>
              {msg}
            </Banner>
          )}
          {transport === "polling" && <p className="hint">Live updates aren't available here, so this checks every few seconds.</p>}
        </div>

        <footer className="sync-drawer__foot">
          {status?.canSync &&
            (run ? (
              <Button variant="danger" icon="x" onClick={cancel} disabled={busy || run.cancelRequested}>
                {run.cancelRequested ? "Stopping…" : "Cancel sync"}
              </Button>
            ) : (
              <Button variant="primary" icon="refresh" onClick={syncNow} disabled={busy}>
                Sync now
              </Button>
            ))}
          <ButtonLink href="/sources#sync" variant="ghost" onClick={onClose}>
            Sources and history
          </ButtonLink>
        </footer>
      </div>
    </>
  );
}
