"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface Job {
  id: string;
  type: string;
  runtime: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const COMMANDS: Array<{ type: string; label: string }> = [
  { type: "discover", label: "Discover" },
  { type: "poll", label: "Poll all" },
  { type: "rank", label: "Re-rank" },
  { type: "enrich_t1", label: "Enrich comp" },
  { type: "recheck", label: "Recheck all" }, // empty payload → worker rechecks all active postings
];

export function ActivityPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agentOnline, setAgentOnline] = useState(false);
  const [agent, setAgent] = useState<{ flags?: Record<string, unknown>; enabledSources?: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const activeRef = useRef(false); // drives poll cadence without re-subscribing

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        const next: Job[] = d.jobs ?? [];
        setJobs(next);
        setAgentOnline(!!d.agentOnline);
        setAgent(d.heartbeat ?? null);
        activeRef.current = next.some((j) => j.status === "queued" || j.status === "running");
      }
    } catch {
      /* ignore */
    }
  }, []);

  // self-scheduling poller: mounts ONCE (load is stable). Faster when jobs are
  // active, slow when idle — and never re-subscribes, so no fetch storm.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!cancelled) timer = setTimeout(tick, activeRef.current ? 1500 : 6000);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const enqueue = async (type: string) => {
    setBusy(type);
    await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) });
    setBusy(null);
    load();
  };

  const pending = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const stale = jobs.find((j) => j.status === "queued" && Date.now() - new Date(j.createdAt).getTime() > 12_000);

  return (
    <div className="activity">
      <div className="activity-bar">
        <span className="activity-label">command</span>
        {COMMANDS.map((c) => (
          <button key={c.type} className="cmd" disabled={busy === c.type} onClick={() => enqueue(c.type)}>
            {busy === c.type ? "…" : c.label}
          </button>
        ))}
        <span className="spacer" />
        <span className="agent-pill" data-on={agentOnline}>
          local agent {agentOnline ? "online" : "offline"}
          {agentOnline && agent?.flags ? ` · browser ${agent.flags.browserOn ? "on" : "off"}` : ""}
          {agentOnline && (agent?.enabledSources?.length ?? 0) > 0 ? ` · ${agent!.enabledSources!.join(",")}` : ""}
        </span>
        {pending > 0 && <span className="pending">{pending} active</span>}
      </div>

      {stale && (
        <div className="worker-hint">
          ⚠ jobs are queued but nothing is draining — run <code>pnpm --filter @jobflow/worker runner</code>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="job-list">
          {jobs.slice(0, 6).map((j) => (
            <div className="job" key={j.id}>
              <span className={`jstatus s-${j.status}`}>{statusDot(j.status)}</span>
              <span className="jtype">{j.type}</span>
              <span className="jresult">{summary(j)}</span>
              <span className="jtime">{ago(j.finishedAt ?? j.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusDot(s: string): string {
  return s === "done" ? "✓" : s === "error" ? "✗" : s === "running" ? "▶" : "•";
}
function summary(j: Job): string {
  if (j.status === "error") return j.error ?? "error";
  if (!j.result) return j.status;
  const r = j.result;
  if ("postingsFetched" in r) return `${r.companiesPolled} co · ${r.postingsFetched} postings`;
  if ("ranked" in r) return `${r.scored} scored → ${r.ranked} ranked`;
  if ("seeded" in r) return `seeded ${r.seeded} · resolved ${r.resolved}`;
  if ("companiesEnriched" in r) return `${r.companiesEnriched} co comp · ${r.postingsEstimated} est`;
  if ("purged" in r) return `${r.purged} purged`;
  if ("staled" in r) return `${r.requested} rechecked · ${r.staled} stale`; // RecheckStats
  return j.status;
}
function ago(t: string | null): string {
  if (!t) return "";
  const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}
