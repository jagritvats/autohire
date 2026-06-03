// JobFlow extension service worker. Forwards captured postings to the local app.
// No background crawling, no scheduled scraping — that's the local Tier-3 cron's
// job (separate, flag-guarded). This worker only relays explicit user captures.

const API = "http://localhost:3000";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "capture") {
    fetch(`${API}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg.posting),
    })
      .then((r) => sendResponse({ ok: r.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
  return false;
});
