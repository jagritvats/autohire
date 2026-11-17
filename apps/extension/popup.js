// Reflects the server's automation flags (GET /api/config via the service worker).
// Tolerates failure: the rows stay "—" and the reason is shown. Text only, never HTML.
import { getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

function set(id, on, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text);
  el.className = on ? "on" : "off";
}

async function main() {
  const { serverUrl } = await getSettings(); // normalised http(s) only
  $("app-link").href = serverUrl;
  $("options-link").addEventListener("click", () => chrome.runtime.openOptionsPage());

  const res = await chrome.runtime.sendMessage({ type: "config" }).catch(() => null);
  const flags = res?.ok ? res.data?.automationFlags : null;
  if (!flags) {
    const err = $("err");
    err.textContent = res?.error ?? "Could not read flags from the server.";
    err.hidden = false;
    return;
  }
  const sources = Array.isArray(flags.tier3Sources) ? flags.tier3Sources.map(String) : [];
  set("f-browser", flags.browser === "on", flags.browser === "on" ? "on" : "off");
  set("f-mode", flags.mode === "fill", flags.mode === "fill" ? "fill" : "capture");
  set("f-t3", sources.length > 0, sources.join(", ") || "none");
}

main();
