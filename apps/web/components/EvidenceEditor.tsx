"use client";

import { useCallback, useEffect, useState } from "react";

interface EvidenceRow {
  id: string;
  project: string;
  headline: string;
  detail: string;
  metric: string | null;
  tags: string[];
}

export interface PromoteItem {
  source: string;
  item: Record<string, unknown>;
}

const blank = (): EvidenceRow => ({ id: "", project: "", headline: "", detail: "", metric: "", tags: [] });

/**
 * Evidence Bank editor — the citeable spine generation grounds on (§4, invariant #3).
 * Edits here auto-invalidate cached drafts (the tailor input hash covers evidence).
 */
export function EvidenceEditor({ promote = [] }: { promote?: PromoteItem[] }) {
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/evidence", { cache: "no-store" });
    if (res.ok) {
      const { evidence } = await res.json();
      setRows(
        evidence.map((e: EvidenceRow) => ({
          id: e.id,
          project: e.project,
          headline: e.headline,
          detail: e.detail,
          metric: e.metric ?? "",
          tags: e.tags ?? [],
        })),
      );
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const setField = (i: number, patch: Partial<EvidenceRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async (row: EvidenceRow) => {
    setBusy(row.id || "new");
    setMsg(null);
    const res = await fetch("/api/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...row, metric: row.metric || null }),
    });
    setBusy(null);
    if (!res.ok) return setMsg("Save failed.");
    await load();
    setMsg("Saved to the Evidence Bank.");
  };

  const remove = async (id: string) => {
    if (!id) return setRows((rs) => rs.filter((r) => r.id)); // drop an unsaved blank
    setBusy(id);
    await fetch(`/api/evidence?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(null);
    await load();
  };

  const promoteOne = async (p: PromoteItem) => {
    const draft = toEvidenceDraft(p);
    setBusy(`promote:${draft.headline}`);
    await fetch("/api/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    setBusy(null);
    await load();
    setMsg(`Promoted “${draft.project}” into the Evidence Bank — edit it below.`);
  };

  return (
    <div className="evidence">
      {promote.length > 0 && (
        <div className="promote-strip">
          <span className="hint">Promote from connected context →</span>
          <div className="promote-row">
            {promote.slice(0, 12).map((p, i) => (
              <button key={i} className="chip" disabled={busy?.startsWith("promote")} onClick={() => promoteOne(p)} title="add as a cited evidence entry">
                + {promoteLabel(p)}
              </button>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 && <div className="gen-empty">No evidence yet — add an entry, or promote one from your imports.</div>}

      {rows.map((r, i) => (
        <div className="ev-row" key={r.id || `new-${i}`}>
          <div className="ev-line">
            <input className="ev-project" value={r.project} placeholder="project" onChange={(e) => setField(i, { project: e.target.value })} />
            <input className="ev-headline" value={r.headline} placeholder="headline — what you built" onChange={(e) => setField(i, { headline: e.target.value })} />
          </div>
          <textarea className="ev-detail" rows={2} value={r.detail} placeholder="detail — specifics, the hard part" onChange={(e) => setField(i, { detail: e.target.value })} />
          <div className="ev-line">
            <input className="ev-metric" value={r.metric ?? ""} placeholder="metric (optional)" onChange={(e) => setField(i, { metric: e.target.value })} />
            <input
              className="ev-tags"
              value={r.tags.join(", ")}
              placeholder="tags, comma-separated"
              onChange={(e) => setField(i, { tags: e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) })}
            />
            <button className="cmd" disabled={busy === (r.id || "new")} onClick={() => save(r)}>
              {busy === (r.id || "new") ? "saving…" : "save"}
            </button>
            <button className="cmd" onClick={() => remove(r.id)}>
              delete
            </button>
          </div>
        </div>
      ))}

      <button className="cmd add" style={{ marginTop: 10 }} onClick={() => setRows((rs) => [...rs, blank()])}>
        + add evidence
      </button>
      {msg && <span className="ev-msg">{msg}</span>}
    </div>
  );
}

function promoteLabel(p: PromoteItem): string {
  const it = p.item;
  if (p.source === "github") return String(it.name ?? "repo");
  if (p.source === "linkedin") return String(it.title ?? it.company ?? "role");
  return "item";
}

/** Map a connected-context item → an Evidence draft (server assigns id). */
function toEvidenceDraft(p: PromoteItem): {
  project: string;
  headline: string;
  detail: string;
  metric: string | null;
  tags: string[];
} {
  const it = p.item;
  if (p.source === "github") {
    const name = String(it.name ?? "repo");
    const desc = String(it.description ?? "").trim();
    const lang = String(it.language ?? "").toLowerCase();
    const topics = Array.isArray(it.topics) ? (it.topics as string[]).map((t) => t.toLowerCase()) : [];
    const stars = Number(it.stars ?? 0);
    return {
      project: name,
      headline: desc || `GitHub project: ${name}`,
      detail: desc || `Open-source/personal project ${name}${lang ? ` (${lang})` : ""}.`,
      metric: stars ? `★${stars}` : null,
      tags: [...new Set([lang, ...topics, "github"].filter(Boolean))],
    };
  }
  if (p.source === "linkedin") {
    const title = String(it.title ?? "");
    const company = String(it.company ?? "");
    const desc = String(it.description ?? "").trim();
    return {
      project: company || title,
      headline: title ? `${title}${company ? ` @ ${company}` : ""}` : company,
      detail: desc || `${title}${company ? ` at ${company}` : ""}.`,
      metric: null,
      tags: ["linkedin"],
    };
  }
  return { project: "", headline: "", detail: String(it.content ?? ""), metric: null, tags: [] };
}
