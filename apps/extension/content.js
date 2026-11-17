// JobFlow content script (§7.1 layer 1 — instrumentation, read-only).
// Acts ONLY on a page you're already viewing. No background crawling. It:
//   1. extracts the visible posting,
//   2. asks the JobFlow app for a match score,
//   3. injects a small inline panel with "why it fits" + a one-click capture.

// All app calls go through the service worker (it holds the configured server's host
// permission + API token); the app only accepts requests from the extension's origin.
// Read-only: nothing here fills or submits a form.

function text(selector) {
  return document.querySelector(selector)?.textContent?.trim() || undefined;
}

function extractPosting() {
  const title =
    document.querySelector("h1, [class*='posting-headline'], [class*='job-title']")?.textContent?.trim() ?? document.title;
  const body = document.querySelector("[class*='description'], [class*='content'], main, article")?.innerText ?? "";
  // best-effort: boards name the employer in a company element or og:site_name
  const company =
    text("[class*='company-name'], [class*='companyName'], [class*='topcard__org-name'], [class*='comp-name']") ??
    document.querySelector("meta[property='og:site_name']")?.content?.trim();
  const where = text("[class*='location'], [class*='job-location'], [class*='topcard__flavor--bullet']");
  return {
    url: location.href,
    title,
    jdText: body.slice(0, 8000),
    ...(company ? { company: company.slice(0, 200) } : {}),
    ...(where ? { location: where.slice(0, 200) } : {}),
  };
}

/** LinkedIn is matched site-wide (so SPA navigation INTO /jobs is seen); act on job pages only. */
function isJobPage() {
  if (/(^|\.)linkedin\.com$/.test(location.hostname)) return location.pathname.startsWith("/jobs");
  return true;
}

// bumps on every navigation so a slow score for the previous job never renders on the next
let generation = 0;

async function scoreAndRender() {
  const gen = generation;
  if (!isJobPage() || document.getElementById("jobflow-panel")) return;
  const posting = extractPosting();
  if (!posting.title || posting.jdText.length < 120) return;

  let result = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "score", posting });
    if (res?.ok) result = res.data;
  } catch {
    /* app not running — render capture-only panel */
  }
  if (gen !== generation || document.getElementById("jobflow-panel")) return; // navigated meanwhile
  renderPanel(posting, result);
}

// ── SPA navigation (LinkedIn, Ashby…): the URL changes without a page load, so the
// script would otherwise keep showing the FIRST job's score. A content script runs in
// an isolated world and can't see the page's history.pushState, so watch the URL via
// DOM mutations + popstate, throttled, and re-score once the new content settles.
let lastHref = location.href;
let settleTimer = null;
let checkQueued = false;

function onPossibleNavigation() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  generation++;
  document.getElementById("jobflow-panel")?.remove();
  clearTimeout(settleTimer);
  // give the SPA time to render the new job; retry once if the JD wasn't there yet
  settleTimer = setTimeout(() => {
    const gen = generation;
    scoreAndRender().then(() => {
      if (gen === generation && !document.getElementById("jobflow-panel")) {
        settleTimer = setTimeout(() => void scoreAndRender(), 2000);
      }
    });
  }, 1200);
}

function queueCheck() {
  if (checkQueued) return;
  checkQueued = true;
  setTimeout(() => {
    checkQueued = false;
    onPossibleNavigation();
  }, 400); // at most a few URL checks per second, however busy the page's DOM is
}

new MutationObserver(queueCheck).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", queueCheck);
window.addEventListener("hashchange", queueCheck);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function renderPanel(posting, result) {
  const el = document.createElement("div");
  el.id = "jobflow-panel";
  el.style.cssText =
    "position:fixed;right:18px;bottom:18px;z-index:2147483647;width:288px;" +
    "background:#0c0e12;color:#e7e4da;border:1px solid rgba(180,200,190,.18);" +
    "border-radius:8px;padding:14px;font:13px/1.45 ui-monospace,monospace;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.5)";
  const score = typeof result?.score === "number" ? result.score : "—";
  const band = (result?.score ?? 0) >= 78 ? "#5ef2a0" : (result?.score ?? 0) >= 60 ? "#f2b35e" : "#9aa09a";
  el.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">
       <span style="font-style:italic;font-family:Georgia,serif;font-size:18px">Job<span style="color:#5ef2a0">Flow</span></span>
       <span style="font-size:26px;font-weight:600;color:${band}">${score}</span>
     </div>
     <div style="color:#9aa09a;font-size:11px;margin:6px 0">${esc((result?.stackNote ?? "Capture this posting into JobFlow.").slice(0, 160))}${result?.inFeed ? " · in your feed" : ""}</div>
     ${(result?.redFlags ?? []).map((f) => `<div style="color:#f2b35e;font-size:11px">⚠ ${esc(f)}</div>`).join("")}
     <button id="jf-capture" style="margin-top:10px;width:100%;background:rgba(94,242,160,.08);color:#5ef2a0;border:1px solid #2f6f4d;border-radius:6px;padding:7px;cursor:pointer;font:inherit">+ Capture to JobFlow</button>`;
  document.body.appendChild(el);
  el.querySelector("#jf-capture").onclick = async () => {
    const btn = el.querySelector("#jf-capture");
    btn.textContent = "capturing…";
    const res = await chrome.runtime.sendMessage({ type: "capture", posting }).catch(() => null);
    btn.textContent = res?.ok ? (res.data?.boardRegistered ? "✓ captured · board added" : "✓ captured") : "✗ is JobFlow running?";
  };
}

scoreAndRender();
