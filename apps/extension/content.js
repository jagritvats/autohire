// JobFlow content script (§7.1 layer 1 — instrumentation, read-only).
// Acts ONLY on a page you're already viewing. No background crawling. It:
//   1. extracts the visible posting,
//   2. asks the JobFlow app for a match score,
//   3. injects a small inline panel with "why it fits" + a one-click capture.

const API = "http://localhost:3000"; // local JobFlow app

function extractPosting() {
  const host = location.hostname;
  const title =
    document.querySelector("h1, [class*='posting-headline'], [class*='job-title']")?.textContent?.trim() ?? document.title;
  const body = document.querySelector("[class*='description'], [class*='content'], main, article")?.innerText ?? "";
  return {
    source: host.includes("greenhouse") ? "greenhouse"
      : host.includes("lever") ? "lever"
      : host.includes("ashby") ? "ashby"
      : host.includes("naukri") ? "naukri"
      : host.includes("linkedin") ? "linkedin" : "unknown",
    url: location.href,
    title,
    jdText: body.slice(0, 8000),
  };
}

async function scoreAndRender() {
  if (document.getElementById("jobflow-panel")) return;
  const posting = extractPosting();
  if (!posting.title || posting.jdText.length < 120) return;

  let result = null;
  try {
    const res = await fetch(`${API}/api/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(posting),
    });
    if (res.ok) result = await res.json();
  } catch {
    /* app not running — render capture-only panel */
  }
  renderPanel(posting, result);
}

function renderPanel(posting, result) {
  const el = document.createElement("div");
  el.id = "jobflow-panel";
  el.style.cssText =
    "position:fixed;right:18px;bottom:18px;z-index:2147483647;width:288px;" +
    "background:#0c0e12;color:#e7e4da;border:1px solid rgba(180,200,190,.18);" +
    "border-radius:8px;padding:14px;font:13px/1.45 ui-monospace,monospace;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.5)";
  const score = result?.score ?? "—";
  const band = (result?.score ?? 0) >= 78 ? "#5ef2a0" : (result?.score ?? 0) >= 60 ? "#f2b35e" : "#9aa09a";
  el.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">
       <span style="font-style:italic;font-family:Georgia,serif;font-size:18px">Job<span style="color:#5ef2a0">Flow</span></span>
       <span style="font-size:26px;font-weight:600;color:${band}">${score}</span>
     </div>
     <div style="color:#9aa09a;font-size:11px;margin:6px 0">${(result?.stackNote ?? "Capture this posting into JobFlow.").slice(0, 160)}</div>
     ${(result?.redFlags ?? []).map((f) => `<div style="color:#f2b35e;font-size:11px">⚠ ${f}</div>`).join("")}
     <button id="jf-capture" style="margin-top:10px;width:100%;background:rgba(94,242,160,.08);color:#5ef2a0;border:1px solid #2f6f4d;border-radius:6px;padding:7px;cursor:pointer;font:inherit">+ Capture to JobFlow</button>`;
  document.body.appendChild(el);
  el.querySelector("#jf-capture").onclick = () => {
    chrome.runtime.sendMessage({ type: "capture", posting });
    el.querySelector("#jf-capture").textContent = "✓ captured";
  };
}

scoreAndRender();
