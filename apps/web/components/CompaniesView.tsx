"use client";

import { useEffect, useState, useCallback } from "react";

interface Row {
  id: string;
  name: string;
  atsType: string;
  atsSlug: string | null;
  tags: string[];
  pollCadence: string;
  status: string;
  lastPolled: string | null;
  postings: number;
}

export function CompaniesView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/companies", { cache: "no-store" });
    if (res.ok) setRows((await res.json()).companies);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!input.trim()) return;
    setAdding(true);
    setMsg(null);
    const isUrl = /^https?:\/\//.test(input.trim());
    const res = await fetch("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isUrl ? { careersUrl: input.trim() } : { name: input.trim() }),
    });
    const d = await res.json();
    setMsg(
      d.detection?.atsType && d.detection.atsType !== "unknown"
        ? `Resolved ${d.company.name} → ${d.detection.atsType}/${d.detection.atsSlug} · polling…`
        : `Added ${d.company?.name ?? input} (ATS unresolved — add a careers URL to resolve).`,
    );
    setInput("");
    setAdding(false);
    setTimeout(load, 1200);
  };

  const pollNow = async (id: string) => {
    await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "poll", payload: { companyId: id } }) });
    setMsg("Poll queued — watch the activity panel.");
  };
  const setStatus = async (id: string, status: string) => {
    await fetch("/api/companies", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }) });
    load();
  };
  const setCadence = async (id: string, pollCadence: string) => {
    await fetch("/api/companies", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, pollCadence }) });
    load();
  };
  const remove = async (id: string) => {
    await fetch("/api/companies", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    load();
  };

  const resolved = rows.filter((r) => r.atsType !== "unknown").length;

  return (
    <div className="companies">
      <div className="add-row">
        <input
          aria-label="Add company by name or careers URL"
          placeholder="Add company by name or careers URL…  (e.g. Razorpay  ·  https://boards.greenhouse.io/acme)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="cmd add" onClick={add} disabled={adding}>
          {adding ? "resolving…" : "+ add"}
        </button>
      </div>
      <div aria-live="polite">{msg && <div className="add-msg">{msg}</div>}</div>

      <div className="reg-meta">
        {rows.length} companies · {resolved} resolved to an ATS board · {rows.reduce((s, r) => s + r.postings, 0)} active postings
      </div>

      <div className="reg-table">
        <div className="reg-head">
          <span>company</span>
          <span>ats</span>
          <span>postings</span>
          <span>cadence</span>
          <span>status</span>
          <span>actions</span>
        </div>
        {rows.map((r) => (
          <div className="reg-row" key={r.id} data-paused={r.status !== "active"}>
            <span className="rname">
              {r.name}
              {r.tags.length > 0 && <span className="rtags">{r.tags.slice(0, 3).join(" · ")}</span>}
            </span>
            <span className="rats">
              {r.atsType === "unknown" ? <em>unresolved</em> : <code>{r.atsType}/{r.atsSlug}</code>}
            </span>
            <span className="rcount">{r.postings}</span>
            <select aria-label={`Poll cadence for ${r.name}`} value={r.pollCadence} onChange={(e) => setCadence(r.id, e.target.value)}>
              {["daily", "weekly", "manual"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <span className={`rstatus s-${r.status}`}>{r.status}</span>
            <span className="ractions">
              <button onClick={() => pollNow(r.id)} disabled={r.atsType === "unknown"} title="poll now">
                poll
              </button>
              <button onClick={() => setStatus(r.id, r.status === "active" ? "paused" : "active")}>
                {r.status === "active" ? "pause" : "resume"}
              </button>
              <button className="danger" onClick={() => remove(r.id)} title="remove" aria-label={`Remove ${r.name}`}>
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
