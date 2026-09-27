// JobFlow extension service worker. Relays the content script's explicit requests to the
// local app: a score for the page you're viewing, and a capture when you click it. No
// background crawling, no scheduled scraping — that's the local agent's job (separate,
// flag-guarded). The app only accepts these calls from the extension's origin.

const API = "http://localhost:3000";
const ROUTES = { score: "/api/score", capture: "/api/capture" };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const route = ROUTES[msg?.type];
  if (!route) return false;
  fetch(`${API}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg.posting),
  })
    .then(async (r) => sendResponse({ ok: r.ok, data: r.ok ? await r.json() : null }))
    .catch(() => sendResponse({ ok: false }));
  return true; // async response
});
