// JobFlow extension service worker. Relays the content script's / popup's explicit
// requests to YOUR JobFlow server: a score for the page you're viewing, a capture when
// you click it, and the automation flags for the popup. No background crawling, no
// scheduled scraping — that's the local agent's job (separate, flag-guarded). Read-only:
// nothing here fills or submits a form.
//
// The server URL + API token come from the options page (chrome.storage.local). The
// token is sent ONLY to the configured server, as `Authorization: Bearer <token>`.
import { getSettings, hasHostPermission } from "./settings.js";

const ROUTES = {
  score: { method: "POST", path: "/api/score" },
  capture: { method: "POST", path: "/api/capture" },
  config: { method: "GET", path: "/api/config" },
};

async function callServer(type, body) {
  const route = ROUTES[type];
  const { serverUrl, apiToken } = await getSettings();
  if (!(await hasHostPermission(serverUrl))) {
    return { ok: false, error: `No permission for ${serverUrl} — open the extension options and save the server again.` };
  }
  const headers = { accept: "application/json" };
  if (route.method === "POST") headers["content-type"] = "application/json";
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  try {
    const r = await fetch(`${serverUrl}${route.path}`, {
      method: route.method,
      headers,
      ...(route.method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      credentials: "omit", // auth is the token, never ambient cookies
    });
    if (!r.ok) {
      const error =
        r.status === 401 || r.status === 403 ? "Not authorised — set an API token in the extension options." : `Server error ${r.status}`;
      return { ok: false, status: r.status, error };
    }
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, error: `Could not reach ${serverUrl} — is JobFlow running?` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !Object.hasOwn(ROUTES, msg.type)) return false;
  callServer(msg.type, msg.posting).then(sendResponse);
  return true; // async response
});
